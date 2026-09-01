import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import PresencePanel from './PresencePanel';
import type { WhiteboardUser } from '@/types/whiteboard';
import type { ParticipantState } from '@/lib/av/avSession';

function makeUser(overrides: Partial<WhiteboardUser> = {}): WhiteboardUser {
  return {
    peerId: 'peer-1',
    userName: 'Alice',
    color: '#3498db',
    isHost: false,
    ...overrides,
  };
}

const noop = vi.fn();

function renderPanel(
  users: WhiteboardUser[],
  options: {
    avPeerStates?: ReadonlyMap<
      string,
      { micMuted: boolean; camOn: boolean; quality?: ParticipantState['quality'] }
    >;
    localPeerId?: string;
    isLocalHost?: boolean;
    waitingPeers?: WhiteboardUser[];
    speakingPeerIds?: ReadonlySet<string>;
    onMutePeer?: (peerId: string, kind: 'audio' | 'video') => void;
  } = {},
) {
  return render(
    <PresencePanel
      users={users}
      waitingPeers={options.waitingPeers ?? []}
      localPeerId={options.localPeerId ?? 'peer-local'}
      isLocalHost={options.isLocalHost ?? false}
      collapsed={false}
      onToggle={noop}
      onApprove={noop}
      onReject={noop}
      onKick={noop}
      onSuspend={noop}
      avPeerStates={options.avPeerStates}
      onMutePeer={options.onMutePeer}
      speakingPeerIds={options.speakingPeerIds}
    />,
  );
}

describe('PresencePanel host label', () => {
  it('shows a Host badge for the server-verified owner', () => {
    renderPanel([
      makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true }),
      makeUser({ peerId: 'peer-student', userName: 'Student', isHost: false }),
    ]);

    expect(screen.getByTestId('whiteboard-user-host-peer-owner').textContent).toContain('Host');
    expect(screen.queryByTestId('whiteboard-user-host-peer-student')).toBeNull();
  });

  it('does not label a non-owner who uses the owner display name', () => {
    renderPanel([
      makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true }),
      makeUser({ peerId: 'peer-impostor', userName: 'Teacher', isHost: false }),
    ]);

    expect(screen.getByTestId('whiteboard-user-host-peer-owner')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-user-host-peer-impostor')).toBeNull();
  });
});

describe('PresencePanel name discriminators', () => {
  it('shows distinct account discs for duplicate names on the owner list only', () => {
    renderPanel(
      [
        makeUser({
          peerId: 'peer-owner',
          userName: 'Teacher',
          isHost: true,
          accountId: 'aaaa1111bbbb2222',
        }),
        makeUser({
          peerId: 'peer-impostor',
          userName: 'Teacher',
          isHost: false,
          accountId: 'cccc3333dddd4444',
        }),
      ],
      { isLocalHost: true },
    );

    const ownerDisc = screen.getByTestId('whiteboard-user-disc-peer-owner');
    const impostorDisc = screen.getByTestId('whiteboard-user-disc-peer-impostor');
    expect(ownerDisc.textContent).toBe('2222');
    expect(impostorDisc.textContent).toBe('4444');
    expect(ownerDisc.textContent).not.toBe(impostorDisc.textContent);
    expect(screen.getByTestId('whiteboard-user-host-peer-owner')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-user-host-peer-impostor')).toBeNull();
  });

  it('shows account discs on waiting-queue duplicates in the owner list', () => {
    renderPanel(
      [
        makeUser({
          peerId: 'peer-owner',
          userName: 'Teacher',
          isHost: true,
          accountId: 'aaaa1111bbbb2222',
        }),
      ],
      {
        isLocalHost: true,
        waitingPeers: [
          makeUser({
            peerId: 'peer-waiting',
            userName: 'Teacher',
            isHost: false,
            isWaiting: true,
            accountId: 'eeee5555ffff6666',
          }),
        ],
      },
    );

    expect(screen.getByTestId('whiteboard-user-disc-peer-owner').textContent).toBe('2222');
    expect(screen.getByTestId('whiteboard-user-disc-peer-waiting').textContent).toBe('6666');
  });

  it('keeps Let in as a named button for a long waiting display name', () => {
    renderPanel(
      [makeUser({ peerId: 'peer-owner', userName: 'HostBadgeHost', isHost: true })],
      {
        isLocalHost: true,
        waitingPeers: [
          makeUser({
            peerId: 'peer-waiting',
            userName: 'HostBadgePeer',
            isHost: false,
            isWaiting: true,
            accountId: 'acct-wait-1',
          }),
        ],
      },
    );

    expect(
      screen.getByTestId('whiteboard-user-peer-waiting').querySelector('button'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Let in' })).toBeTruthy();
  });

  it('does not show discs when names are unique', () => {
    renderPanel(
      [
        makeUser({
          peerId: 'peer-owner',
          userName: 'Teacher',
          isHost: true,
          accountId: 'aaaa1111bbbb2222',
        }),
        makeUser({
          peerId: 'peer-student',
          userName: 'Student',
          isHost: false,
          accountId: 'cccc3333dddd4444',
        }),
      ],
      { isLocalHost: true },
    );

    expect(screen.queryByTestId('whiteboard-user-disc-peer-owner')).toBeNull();
    expect(screen.queryByTestId('whiteboard-user-disc-peer-student')).toBeNull();
  });

  it('does not show discs to non-owners even when names collide', () => {
    renderPanel(
      [
        makeUser({
          peerId: 'peer-owner',
          userName: 'Teacher',
          isHost: true,
          accountId: 'aaaa1111bbbb2222',
        }),
        makeUser({
          peerId: 'peer-impostor',
          userName: 'Teacher',
          isHost: false,
          accountId: 'cccc3333dddd4444',
        }),
      ],
      { isLocalHost: false },
    );

    expect(screen.queryByTestId('whiteboard-user-disc-peer-owner')).toBeNull();
    expect(screen.queryByTestId('whiteboard-user-disc-peer-impostor')).toBeNull();
  });
});

describe('PresencePanel speaking indicator', () => {
  it('shows a readable speaking ring on the active user row avatar only', () => {
    renderPanel(
      [
        makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        makeUser({ peerId: 'peer-2', userName: 'Bob' }),
      ],
      { speakingPeerIds: new Set(['peer-2']) },
    );

    expect(screen.getByTestId('whiteboard-user-speaking-peer-2').getAttribute('aria-label')).toBe(
      'Bob is speaking',
    );
    expect(screen.queryByTestId('whiteboard-user-speaking-peer-1')).toBeNull();
  });
});

describe('PresencePanel A/V roster state', () => {
  it('shows mic and camera state only for call participants', () => {
    renderPanel(
      [
        makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        makeUser({ peerId: 'peer-2', userName: 'Bob' }),
      ],
      {
        avPeerStates: new Map([
          ['peer-2', { micMuted: true, camOn: false }],
        ]),
      },
    );

    expect(screen.queryByTestId('whiteboard-user-av-peer-1')).toBeNull();
    expect(screen.getByTestId('whiteboard-user-av-peer-2').textContent).toContain('Mic off');
    expect(screen.getByTestId('whiteboard-user-av-peer-2').textContent).toContain('Camera off');
  });

  it('shows an accessible poor connection indicator only for poor or lost participants', () => {
    renderPanel(
      [
        makeUser({ peerId: 'peer-poor', userName: 'Poor Peer' }),
        makeUser({ peerId: 'peer-lost', userName: 'Lost Peer' }),
        makeUser({ peerId: 'peer-good', userName: 'Good Peer' }),
        makeUser({ peerId: 'peer-excellent', userName: 'Excellent Peer' }),
        makeUser({ peerId: 'peer-unknown', userName: 'Unknown Peer' }),
      ],
      {
        avPeerStates: new Map([
          ['peer-poor', { micMuted: false, camOn: true, quality: 'poor' }],
          ['peer-lost', { micMuted: false, camOn: true, quality: 'lost' }],
          ['peer-good', { micMuted: false, camOn: true, quality: 'good' }],
          ['peer-excellent', { micMuted: false, camOn: true, quality: 'excellent' }],
          ['peer-unknown', { micMuted: false, camOn: true, quality: 'unknown' }],
        ]),
      },
    );

    expect(screen.getByTestId('whiteboard-user-connection-quality-peer-poor').getAttribute('aria-label')).toBe(
      'Poor Peer connection is poor',
    );
    expect(screen.getByTestId('whiteboard-user-connection-quality-peer-lost').getAttribute('aria-label')).toBe(
      'Lost Peer connection is lost',
    );
    expect(screen.queryByTestId('whiteboard-user-connection-quality-peer-good')).toBeNull();
    expect(screen.queryByTestId('whiteboard-user-connection-quality-peer-excellent')).toBeNull();
    expect(screen.queryByTestId('whiteboard-user-connection-quality-peer-unknown')).toBeNull();
  });

  it('shows owner-only mute controls for remote call participants', () => {
    const onMutePeer = vi.fn();
    renderPanel(
      [
        makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true }),
        makeUser({ peerId: 'peer-student', userName: 'Student', accountId: 'acct-student' }),
      ],
      {
        localPeerId: 'peer-owner',
        isLocalHost: true,
        avPeerStates: new Map([
          ['peer-student', { micMuted: false, camOn: true }],
        ]),
        onMutePeer,
      },
    );

    fireEvent.click(screen.getByTestId('whiteboard-user-mute-audio-peer-student'));
    expect(onMutePeer).toHaveBeenCalledWith('peer-student', 'audio');

    fireEvent.click(screen.getByTestId('whiteboard-user-mute-video-peer-student'));
    expect(onMutePeer).toHaveBeenCalledWith('peer-student', 'video');
  });

  it('does not show owner mute controls to non-owners', () => {
    renderPanel(
      [
        makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true }),
        makeUser({ peerId: 'peer-student', userName: 'Student' }),
      ],
      {
        localPeerId: 'peer-student',
        isLocalHost: false,
        avPeerStates: new Map([
          ['peer-owner', { micMuted: false, camOn: true }],
        ]),
      },
    );

    expect(screen.queryByTestId('whiteboard-user-mute-audio-peer-owner')).toBeNull();
    expect(screen.queryByTestId('whiteboard-user-mute-video-peer-owner')).toBeNull();
  });
});

describe('PresencePanel moderation menu', () => {
  it('invokes onKick from a click on Kick from Room', () => {
    const onKick = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-owner', userName: 'KickHost', isHost: true }),
          makeUser({
            peerId: 'peer-student',
            userName: 'Peer',
            isHost: false,
            accountId: 'acct-peer',
          }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-owner"
        isLocalHost={true}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={onKick}
        onSuspend={noop}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-user-options-peer-student'));
    fireEvent.click(screen.getByTestId('whiteboard-context-kick'));
    expect(onKick).toHaveBeenCalledWith('peer-student', 'acct-peer');
  });

  it('invokes onKick from a native pointerdown on Kick from Room', () => {
    const onKick = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-owner', userName: 'KickHost', isHost: true }),
          makeUser({
            peerId: 'peer-student',
            userName: 'Peer',
            isHost: false,
            accountId: 'acct-peer',
          }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-owner"
        isLocalHost={true}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={onKick}
        onSuspend={noop}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-user-options-peer-student'));
    fireEvent.pointerDown(screen.getByTestId('whiteboard-context-kick'));
    expect(onKick).toHaveBeenCalledWith('peer-student', 'acct-peer');
  });

  it('invokes onSuspend from a click on Send to Waiting Room', () => {
    const onSuspend = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-owner', userName: 'SuspendHost', isHost: true }),
          makeUser({
            peerId: 'peer-student',
            userName: 'Peer',
            isHost: false,
            accountId: 'acct-peer',
          }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-owner"
        isLocalHost={true}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={onSuspend}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-user-options-peer-student'));
    fireEvent.click(screen.getByTestId('whiteboard-context-suspend'));
    expect(onSuspend).toHaveBeenCalledWith('peer-student', 'acct-peer');
  });
});

describe('PresencePanel raise hand', () => {
  it('shows a Raise hand control for the local admitted user', () => {
    const onRaiseHand = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-local', userName: 'Me', isHost: false, handRaised: false }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        onRaiseHand={onRaiseHand}
      />,
    );

    fireEvent.click(screen.getByTestId('whiteboard-raise-hand'));
    expect(onRaiseHand).toHaveBeenCalledWith(true);
  });

  it('shows Lower hand when the local user already has a raised hand', () => {
    const onRaiseHand = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-local', userName: 'Me', isHost: false, handRaised: true }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        onRaiseHand={onRaiseHand}
      />,
    );

    expect(screen.getByTestId('whiteboard-raise-hand').textContent).toMatch(/lower/i);
    fireEvent.click(screen.getByTestId('whiteboard-raise-hand'));
    expect(onRaiseHand).toHaveBeenCalledWith(false);
  });

  it('shows a Hand raised badge for users whose hand is up', () => {
    renderPanel([
      makeUser({ peerId: 'peer-local', userName: 'Me', handRaised: false }),
      makeUser({ peerId: 'peer-student', userName: 'Student', handRaised: true }),
    ], { localPeerId: 'peer-local' });

    expect(screen.getByTestId('whiteboard-user-hand-peer-student').textContent).toMatch(/hand raised/i);
    expect(screen.queryByTestId('whiteboard-user-hand-peer-local')).toBeNull();
  });

  it('does not show a raise control for waiting-room users', () => {
    render(
      <PresencePanel
        users={[]}
        waitingPeers={[
          makeUser({ peerId: 'peer-local', userName: 'Me', isWaiting: true }),
        ]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        onRaiseHand={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('whiteboard-raise-hand')).toBeNull();
  });
  it('does not show a raise control for the host', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-local', userName: 'Me', isHost: true, handRaised: false }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={true}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        onRaiseHand={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('whiteboard-raise-hand')).toBeNull();
  });
});

describe('PresencePanel collapsed state', () => {
  it('shows occupancy count in collapsed state', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
          makeUser({ peerId: 'peer-2', userName: 'Bob' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        maxUsers={10}
      />,
    );

    const count = screen.getByTestId('whiteboard-presence-count');
    expect(count.textContent).toBe('2/10');
  });

  it('reflects maxUsers in the occupancy count', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
          makeUser({ peerId: 'peer-2', userName: 'Bob' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        maxUsers={30}
      />,
    );

    const count = screen.getByTestId('whiteboard-presence-count');
    expect(count.textContent).toBe('2/30');
  });

  it('aria-controls on handle matches the expanded panel id', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const button = screen.getByTestId('whiteboard-presence-toggle');
    const ariaControls = button.getAttribute('aria-controls');
    expect(ariaControls).toBe('whiteboard-presence-panel');
  });

  it('aria-controls remains when expanded', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={false}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const button = screen.getByTestId('whiteboard-presence-toggle');
    const ariaControls = button.getAttribute('aria-controls');
    expect(ariaControls).toBe('whiteboard-presence-panel');
  });

  it('aria-label includes counts without waiting', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
          makeUser({ peerId: 'peer-2', userName: 'Bob' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        maxUsers={10}
      />,
    );

    const button = screen.getByTestId('whiteboard-presence-toggle');
    const ariaLabel = button.getAttribute('aria-label');
    expect(ariaLabel).toMatch(/2/);
    expect(ariaLabel).toMatch(/10/);
    expect(ariaLabel).not.toMatch(/waiting/i);
  });

  it('aria-label includes waiting count when someone is waiting', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[
          makeUser({ peerId: 'peer-waiting', userName: 'Charlie', isWaiting: true }),
        ]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
        maxUsers={10}
      />,
    );

    const button = screen.getByTestId('whiteboard-presence-toggle');
    const ariaLabel = button.getAttribute('aria-label');
    expect(ariaLabel).toMatch(/1/);
    expect(ariaLabel).toMatch(/10/);
    expect(ariaLabel).toMatch(/waiting/i);
  });

  // A live region only announces changes that happen while it is already in the
  // document. One rendered at the same moment as its first message is missed by
  // screen readers, so the empty region has to be there before anyone arrives.
  it('keeps an empty live region mounted while nobody is waiting', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const liveRegion = screen.getByTestId('whiteboard-presence-waiting-live');
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    expect(liveRegion.textContent).toBe('');
  });

  it('announces arrivals as a sentence rather than a bare number', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[
          makeUser({ peerId: 'peer-waiting', userName: 'Charlie', isWaiting: true }),
        ]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const liveRegion = screen.getByTestId('whiteboard-presence-waiting-live');
    expect(liveRegion.textContent).toBe('1 person waiting to be let in');
  });

  it('pluralises the announcement', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[
          makeUser({ peerId: 'peer-w1', userName: 'Charlie', isWaiting: true }),
          makeUser({ peerId: 'peer-w2', userName: 'Dana', isWaiting: true }),
        ]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const liveRegion = screen.getByTestId('whiteboard-presence-waiting-live');
    expect(liveRegion.textContent).toBe('2 people waiting to be let in');
  });

  // The amber badge is the visual channel for the same fact. Marking it live as
  // well would announce the count twice for one arrival.
  it('does not mark the visible badge as a second live region', () => {
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[
          makeUser({ peerId: 'peer-waiting', userName: 'Charlie', isWaiting: true }),
        ]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={noop}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    expect(screen.getAllByTestId('whiteboard-presence-waiting-live')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('regression: whiteboard-presence-toggle still calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(
      <PresencePanel
        users={[
          makeUser({ peerId: 'peer-1', userName: 'Alice' }),
        ]}
        waitingPeers={[]}
        localPeerId="peer-local"
        isLocalHost={false}
        collapsed={true}
        onToggle={onToggle}
        onApprove={noop}
        onReject={noop}
        onKick={noop}
        onSuspend={noop}
      />,
    );

    const button = screen.getByTestId('whiteboard-presence-toggle');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalled();
  });
});
