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
