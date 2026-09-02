import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { afterEach, describe, expect, it, vi } from 'vitest';

const statusListeners: Array<(event: { status?: string; connected?: boolean }) => void> = [];
const syncedListeners: Array<(event: boolean | { synced: boolean }) => void> = [];
const closeListeners: Array<(event: unknown) => void> = [];

vi.mock('./yWebsocketProvider', () => ({
  createYWebsocketProvider: (doc: Y.Doc) => {
    const provider = {
      wsconnected: false,
      shouldConnect: true,
      // A real Awareness, not a stand-in: cursors live here now, so a fake
      // would make every cursor assertion below pass without testing anything.
      awareness: new Awareness(doc),
      connect: vi.fn(),
      destroy: vi.fn(),
      on: (eventName: string, callback: (...args: unknown[]) => void) => {
        if (eventName === 'status') statusListeners.push(callback as (event: { status?: string; connected?: boolean }) => void);
        if (eventName === 'synced') syncedListeners.push(callback as (event: boolean | { synced: boolean }) => void);
        if (eventName === 'connection-close') closeListeners.push(callback);
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
  closeListeners.length = 0;
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

  it('forwards y-websocket connection-close events with code', () => {
    const collab = createCollaboration('close-room');
    const closeEvents: unknown[] = [];
    collab.onChange((type, data) => {
      if (type === 'connection-close') closeEvents.push(data);
    });

    closeListeners.forEach((listener) => listener({ code: 1008 }));

    expect(closeEvents).toEqual([{ code: 1008 }]);
    collab.destroy();
  });

  it('reports connecting status initially when disconnected and shouldConnect is true', () => {
    const collab = createCollaboration('initial-connecting-room');
    const statuses: Array<{ status?: string; connected?: boolean; synced?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    expect(statuses[0]).toEqual({ status: 'connecting', connected: false });
    collab.destroy();
  });

  it('reports disconnected status when disconnected and shouldConnect is false', () => {
    const collab = createCollaboration('shouldconnect-room');
    const statuses: Array<{ status?: string; connected?: boolean; synced?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    if (collab.provider) {
      collab.provider.shouldConnect = false;
    }
    statusListeners.forEach((listener) => listener({ status: 'disconnected' }));

    expect(statuses.at(-1)).toMatchObject({ status: 'disconnected', connected: false });
    collab.destroy();
  });

  it('triggers reconnect on interval when shouldConnect is true and disconnected', () => {
    vi.useFakeTimers();
    try {
      const collab = createCollaboration('reconnect-active-room');
      expect(collab.provider.connect).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(collab.provider.connect).toHaveBeenCalled();
      collab.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trigger reconnect when shouldConnect is false', () => {
    vi.useFakeTimers();
    try {
      const collab = createCollaboration('reconnect-guard-room');
      if (collab.provider) {
        collab.provider.shouldConnect = false;
      }
      vi.advanceTimersByTime(10_000);
      expect(collab.provider.connect).not.toHaveBeenCalled();
      collab.destroy();
    } finally {
      vi.useRealTimers();
    }
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

describe('createCollaboration adoptLocalPeerId', () => {
  it('moves the announced cursor onto the server-issued peer id', () => {
    const collab = createCollaboration('adopt-room', 'user-local-label');
    collab.setLocalUserName('CursorPeer');
    collab.setLocalCursor(12, 34);

    collab.adoptLocalPeerId('user-server-issued');

    expect(collab.localPeerId).toBe('user-server-issued');
    const cursors = collab.getUsers();
    expect(cursors.map((user) => user.peerId)).toEqual(['user-server-issued']);
    expect(cursors[0]?.userName).toBe('CursorPeer');
    expect(cursors.map((user) => user.peerId)).not.toContain('user-local-label');

    collab.destroy();
  });

  it('publishes a cursor under the issued id even when none was written yet', () => {
    const collab = createCollaboration('adopt-empty', 'user-local-label');
    collab.setLocalUserName('CursorPeer');

    collab.adoptLocalPeerId('user-server-issued');

    expect(collab.getUsers().map((user) => user.peerId)).not.toContain('user-local-label');
    expect(collab.getLocalCursor()).toMatchObject({
      peerId: 'user-server-issued',
      userName: 'CursorPeer',
    });

    collab.destroy();
  });
});

describe('createCollaboration cursor storage', () => {
  it('keeps cursor traffic out of the document that gets stored', () => {
    /*
     * The regression this exists for: cursors used to be written into the
     * shared document, one Y.Map key per peer, twenty times a second. The
     * overwritten values were collected but their tombstones were not, so a
     * board grew about 11KB per minute per participant however little was
     * drawn on it -- and a room that stayed open for an hour crossed the 2MB
     * Durable Object storage ceiling on pointer positions alone.
     */
    const collab = createCollaboration('cursor-storage', 'user-a');
    const before = Y.encodeStateAsUpdate(collab.doc).byteLength;

    for (let i = 0; i < 2_000; i++) collab.setLocalCursor(i % 900, i % 600);
    collab.setLocalUserName('Ada');
    collab.setLocalUserColor('#e74c3c');
    collab.adoptLocalPeerId('user-server-issued');

    expect(Y.encodeStateAsUpdate(collab.doc).byteLength).toBe(before);

    collab.destroy();
  });
});

describe('createCollaboration cursor payload', () => {
  it('announces the latest pointer button', () => {
    const collab = createCollaboration('cursor-button-room', 'peer-local');

    collab.setLocalCursor(12, 34, 'down');

    expect(collab.getLocalCursor()).toMatchObject({
      peerId: 'peer-local',
      x: 12,
      y: 34,
      button: 'down',
    });

    collab.destroy();
  });

  it('keeps the button through a peer id adoption mid-stroke', () => {
    const collab = createCollaboration('cursor-button-adopt', 'peer-local');

    collab.setLocalCursor(12, 34, 'down');
    collab.adoptLocalPeerId('peer-issued');

    // Re-announcing under the issued id must not report the pointer as lifted.
    expect(collab.getLocalCursor()).toMatchObject({ peerId: 'peer-issued', button: 'down' });

    collab.destroy();
  });
});
