import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import RemoteCursorOverlay from './RemoteCursorOverlay';
import { IDENTITY_VIEWPORT } from '@/lib/whiteboard/cursorViewport';
import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';

function makeCursor(overrides: Partial<RemoteCursor> = {}): RemoteCursor {
  return {
    peerId: 'peer-1',
    userName: 'Alice',
    color: '#3498db',
    x: 10,
    y: 20,
    ...overrides,
  };
}

function makeUser(overrides: Partial<WhiteboardUser> = {}): WhiteboardUser {
  return {
    peerId: 'peer-1',
    userName: 'Alice',
    color: '#3498db',
    isHost: false,
    ...overrides,
  };
}

describe('RemoteCursorOverlay host label', () => {
  it('shows a Host badge on the owner cursor using server-verified role', () => {
    render(
      <RemoteCursorOverlay
        cursors={[makeCursor({ peerId: 'peer-owner', userName: 'Teacher' })]}
        users={[makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true })]}
        viewport={IDENTITY_VIEWPORT}
      />,
    );

    expect(screen.getByTestId('whiteboard-peer-cursor-host-peer-owner').textContent).toContain('Host');
  });

  it('does not label a non-owner cursor that shares the owner display name', () => {
    render(
      <RemoteCursorOverlay
        cursors={[
          makeCursor({ peerId: 'peer-owner', userName: 'Teacher' }),
          makeCursor({ peerId: 'peer-impostor', userName: 'Teacher', x: 40, y: 50 }),
        ]}
        users={[
          makeUser({ peerId: 'peer-owner', userName: 'Teacher', isHost: true }),
          makeUser({ peerId: 'peer-impostor', userName: 'Teacher', isHost: false }),
        ]}
        viewport={IDENTITY_VIEWPORT}
      />,
    );

    expect(screen.getByTestId('whiteboard-peer-cursor-host-peer-owner')).toBeTruthy();
    expect(screen.queryByTestId('whiteboard-peer-cursor-host-peer-impostor')).toBeNull();
  });
});
