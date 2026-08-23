import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import RemoteCursorOverlay from './RemoteCursorOverlay';
import { IDENTITY_VIEWPORT } from '@/lib/whiteboard/cursorViewport';
import type { RemoteCursor, WhiteboardUser } from '@/types/whiteboard';
import {
  clearWhiteboardLatencyEvents,
  readWhiteboardLatencyEvents,
} from '@/lib/whiteboard/latencyProbe';

const testEnv = process.env as Record<string, string | undefined>;
const originalNodeEnv = testEnv.NODE_ENV;
const originalE2eFlag = testEnv.NEXT_PUBLIC_E2E;
const originalEvents = (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
  .__whiteboardLatencyEvents;

afterEach(() => {
  if (originalNodeEnv === undefined) delete testEnv.NODE_ENV;
  else testEnv.NODE_ENV = originalNodeEnv;
  if (originalE2eFlag === undefined) delete testEnv.NEXT_PUBLIC_E2E;
  else testEnv.NEXT_PUBLIC_E2E = originalE2eFlag;
  if (originalEvents === undefined) {
    delete (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
      .__whiteboardLatencyEvents;
  } else {
    (globalThis.window as Window & { __whiteboardLatencyEvents?: unknown })
      .__whiteboardLatencyEvents = originalEvents;
  }
});

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

  it('records cursor-render after React commits the cursor props in debug mode', () => {
    testEnv.NODE_ENV = 'development';
    delete testEnv.NEXT_PUBLIC_E2E;
    clearWhiteboardLatencyEvents();

    render(
      <RemoteCursorOverlay
        cursors={[makeCursor({ peerId: 'peer-rendered', x: 31, y: 47 })]}
        users={[makeUser({ peerId: 'peer-rendered' })]}
        viewport={IDENTITY_VIEWPORT}
      />,
    );

    expect(readWhiteboardLatencyEvents()).toEqual([
      {
        kind: 'cursor-render',
        at: expect.any(Number),
        peerId: 'peer-rendered',
        x: 31,
        y: 47,
      },
    ]);
  });
});
