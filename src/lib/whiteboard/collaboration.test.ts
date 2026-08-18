import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statusListeners: Array<(event: { status?: string; connected?: boolean }) => void> = [];
const syncedListeners: Array<(event: boolean | { synced: boolean }) => void> = [];

vi.mock('./yWebsocketProvider', () => ({
  createYWebsocketProvider: (doc: Y.Doc) => {
    const provider = {
      wsconnected: false,
      shouldConnect: true,
      connect: vi.fn(),
      destroy: vi.fn(),
      on: (eventName: string, callback: (...args: unknown[]) => void) => {
        if (eventName === 'status') statusListeners.push(callback as (event: { status?: string; connected?: boolean }) => void);
        if (eventName === 'synced') syncedListeners.push(callback as (event: boolean | { synced: boolean }) => void);
      },
    };
    return { provider, status: 'connecting', synced: false };
  },
  destroyProvider: vi.fn(),
}));

import { createCollaboration } from './collaboration';

afterEach(() => {
  statusListeners.length = 0;
  syncedListeners.length = 0;
  vi.clearAllMocks();
});

describe('createCollaboration y-websocket status', () => {
  it('maps y-websocket status events to connected', () => {
    const collab = createCollaboration('status-room');
    const statuses: Array<{ status?: string; connected?: boolean; synced?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    const provider = collab.provider as unknown as { wsconnected: boolean };
    provider.wsconnected = true;
    statusListeners.forEach((listener) => listener({ status: 'connected' }));

    expect(statuses.at(-1)).toMatchObject({ status: 'connected', connected: true });
    collab.destroy();
  });

  it('maps y-websocket synced boolean to synced status', () => {
    const collab = createCollaboration('synced-room');
    const statuses: Array<{ status?: string; connected?: boolean; synced?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    const provider = collab.provider as unknown as { wsconnected: boolean };
    provider.wsconnected = true;
    syncedListeners.forEach((listener) => listener(true));

    expect(statuses.at(-1)).toMatchObject({ status: 'synced', connected: true, synced: true });
    collab.destroy();
  });
});

describe('createCollaboration omitted peerId (SEC-006)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mints localPeerId from crypto.getRandomValues, not Math.random', () => {
    const mathValue = 0.123456789;
    vi.spyOn(Math, 'random').mockReturnValue(mathValue);
    const mathFragment = mathValue.toString(36).substring(2, 9);
    const getRandomValues = vi.spyOn(crypto, 'getRandomValues');

    const first = createCollaboration('room');
    const second = createCollaboration('room');

    expect(first.localPeerId).not.toContain(mathFragment);
    expect(second.localPeerId).not.toContain(mathFragment);
    expect(first.localPeerId).toMatch(/^user-[0-9a-f]{32}$/);
    expect(second.localPeerId).toMatch(/^user-[0-9a-f]{32}$/);
    expect(getRandomValues).toHaveBeenCalled();
    const buf = getRandomValues.mock.calls[0][0] as Uint8Array;
    expect(buf.byteLength).toBeGreaterThanOrEqual(16);
    expect(first.localPeerId).not.toBe(second.localPeerId);

    first.destroy();
    second.destroy();
  });
});
