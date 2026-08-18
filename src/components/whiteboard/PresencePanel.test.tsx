import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
