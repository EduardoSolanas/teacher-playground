import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import PresencePanel from './PresencePanel';
import type { WhiteboardUser } from '@/types/whiteboard';

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
    localPeerId?: string;
    isLocalHost?: boolean;
    waitingPeers?: WhiteboardUser[];
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
