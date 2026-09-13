import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishCursor } from './cursorAwareness';
import { destroyProvider } from './yWebsocketProvider';

const statusListeners: Array<(event: { status?: string; connected?: boolean }) => void> = [];
const syncedListeners: Array<(event: boolean | { synced: boolean }) => void> = [];
const closeListeners: Array<(event: unknown) => void> = [];

vi.mock('./yWebsocketProvider', () => ({
  createYWebsocketProvider: (doc: Y.Doc, roomId: string) => {
    const provider = {
      wsconnected: false,
      shouldConnect: true,
      // A real Awareness, not a stand-in: cursors live here now, so a fake
      // would make every cursor assertion below pass without testing anything.
      // One room deliberately has none, for the providers that carry no cursors.
      awareness: roomId === 'no-awareness-room' ? null : new Awareness(doc),
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

/** The cursor exactly as it sits in awareness, before readers normalize it. */
function localCursorWire(
  collab: ReturnType<typeof createCollaboration>,
): { button?: string; tool?: string } | undefined {
  const awareness = (collab.provider as unknown as { awareness: Awareness }).awareness;
  const state = awareness.getLocalState() as { cursor?: { button?: string; tool?: string } } | null;
  return state?.cursor;
}

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

  it('announces anonymous defaults when adoption publishes the first cursor', () => {
    const collab = createCollaboration('cursor-defaults-room', 'peer-default');

    collab.adoptLocalPeerId('peer-issued');

    expect(collab.getLocalCursor()).toMatchObject({
      peerId: 'peer-issued',
      userName: 'Anonymous',
      color: '#3498db',
      button: 'up',
    });
    // The wire value, before any reader normalizes it.
    expect(localCursorWire(collab)?.button).toBe('up');
    expect(localCursorWire(collab)?.tool).toBe('pointer');

    collab.destroy();
  });

  it('publishes up as the default pointer button', () => {
    const collab = createCollaboration('cursor-default-button-room', 'peer-a');

    collab.setLocalCursor(1, 2);

    expect(localCursorWire(collab)?.button).toBe('up');

    collab.destroy();
  });
});

describe('createCollaboration laser', () => {
  it('announces the laser, and a plain pointer when none is named', () => {
    const collab = createCollaboration('cursor-laser-room', 'peer-local');

    collab.setLocalCursor(12, 34, 'down', 'laser');
    expect(localCursorWire(collab)?.tool).toBe('laser');

    collab.setLocalCursor(12, 34);
    expect(localCursorWire(collab)?.tool).toBe('pointer');

    collab.destroy();
  });

  it('keeps the laser through every re-announcement mid-sweep', () => {
    const collab = createCollaboration('cursor-laser-reannounce', 'peer-local');

    collab.setLocalCursor(12, 34, 'down', 'laser');
    collab.setLocalUserName('Ms Rivera');
    expect(localCursorWire(collab)?.tool).toBe('laser');
    collab.setLocalUserColor('#123456');
    expect(localCursorWire(collab)?.tool).toBe('laser');
    // Re-announcing under the issued id must not drop the laser either.
    collab.adoptLocalPeerId('peer-issued');
    expect(collab.getLocalCursor()).toMatchObject({ peerId: 'peer-issued', button: 'down', tool: 'laser' });

    collab.destroy();
  });
});

describe('createCollaboration rename re-announcement', () => {
  it('re-announces the cursor when the user name changes after it was published', () => {
    const collab = createCollaboration('rename-room', 'peer-a');

    collab.setLocalCursor(5, 6, 'down');
    collab.setLocalUserName('Ada');

    expect(collab.getLocalCursor()).toMatchObject({
      x: 5,
      y: 6,
      userName: 'Ada',
      button: 'down',
    });

    collab.destroy();
  });

  it('does not publish a cursor when renaming before any cursor exists', () => {
    const collab = createCollaboration('rename-empty-room', 'peer-a');

    collab.setLocalUserName('Ada');

    expect(collab.getLocalCursor()).toBeNull();

    collab.destroy();
  });

  it('re-announces the cursor when the color changes after it was published', () => {
    const collab = createCollaboration('recolor-room', 'peer-a');

    collab.setLocalCursor(5, 6);
    collab.setLocalUserColor('#e74c3c');

    expect(collab.getLocalCursor()).toMatchObject({ x: 5, y: 6, color: '#e74c3c' });

    collab.destroy();
  });

  it('does not publish a cursor when recoloring before any cursor exists', () => {
    const collab = createCollaboration('recolor-empty-room', 'peer-a');

    collab.setLocalUserColor('#e74c3c');

    expect(collab.getLocalCursor()).toBeNull();

    collab.destroy();
  });
});

describe('createCollaboration adoptLocalPeerId no-op', () => {
  it('does not publish a cursor for an empty or unchanged peer id', () => {
    const collab = createCollaboration('adopt-noop-room', 'peer-a');

    collab.adoptLocalPeerId('peer-a');
    expect(collab.getLocalCursor()).toBeNull();
    expect(collab.localPeerId).toBe('peer-a');

    collab.adoptLocalPeerId('');
    expect(collab.getLocalCursor()).toBeNull();
    expect(collab.localPeerId).toBe('peer-a');

    collab.destroy();
  });
});

describe('createCollaboration provider status details', () => {
  it('reports disconnected immediately when shouldConnect is already false', () => {
    const collab = createCollaboration('pre-disconnected-room');
    if (collab.provider) {
      collab.provider.shouldConnect = false;
    }
    const statuses: Array<{ status?: string; connected?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    expect(statuses[0]).toEqual({ status: 'disconnected', connected: false });

    collab.destroy();
  });

  it('treats a status event with connected: true as connected', () => {
    const collab = createCollaboration('connected-flag-room');
    const statuses: Array<{ status?: string; connected?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    statusListeners.forEach((listener) => listener({ connected: true }));

    expect(statuses.at(-1)).toMatchObject({ status: 'connected', connected: true });

    collab.destroy();
  });

  it('reports connecting for a disconnected event while the provider should still connect', () => {
    const collab = createCollaboration('shouldconnect-true-room');
    const statuses: Array<{ status?: string; connected?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    statusListeners.forEach((listener) => listener({ status: 'disconnected' }));

    expect(statuses.at(-1)).toMatchObject({ status: 'connecting', connected: false });

    collab.destroy();
  });

  it('reads synced state from an object event when it is not a bare boolean', () => {
    const collab = createCollaboration('synced-object-room');
    const statuses: Array<{ status?: string; synced?: boolean }> = [];
    collab.onChange((type, data) => {
      if (type === 'status') statuses.push(data);
    });

    syncedListeners.forEach((listener) => listener({ synced: false }));

    expect(statuses.at(-1)).toMatchObject({ status: 'connecting', synced: false });

    collab.destroy();
  });

  it('notifies status subscribers when the reconnect interval fires', () => {
    vi.useFakeTimers();
    try {
      const collab = createCollaboration('reconnect-notify-room');
      const statuses: Array<{ status?: string; connected?: boolean }> = [];
      collab.onChange((type, data) => {
        if (type === 'status') statuses.push(data);
      });
      statuses.length = 0;

      vi.advanceTimersByTime(5_000);

      expect(statuses.at(-1)).toMatchObject({ status: 'connecting', connected: false });

      collab.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createCollaboration awareness cursors', () => {
  it('draws remote cursors and notifies subscribers when awareness changes', () => {
    const collab = createCollaboration('awareness-remote-room', 'peer-local');
    const cursorEvents: unknown[] = [];
    collab.onChange((type, data) => {
      if (type === 'cursors') cursorEvents.push(data);
    });
    const awareness = (collab.provider as unknown as { awareness: Awareness }).awareness;
    const remote = new Awareness(new Y.Doc());
    publishCursor(remote, {
      peerId: 'peer-remote',
      userName: 'Remote',
      color: '#e74c3c',
      x: 7,
      y: 8,
      button: 'down',
    });

    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(remote, [remote.clientID]), 'remote');

    expect(cursorEvents.length).toBeGreaterThan(0);
    // Announced with no tool, as a client from before the laser travelled
    // would: it is drawn as an ordinary pointer.
    expect(cursorEvents.at(-1)).toEqual([
      { peerId: 'peer-remote', userName: 'Remote', color: '#e74c3c', x: 7, y: 8, button: 'down', tool: 'pointer' },
    ]);

    collab.destroy();
  });
});

describe('createCollaboration send helpers', () => {
  it('reports false when the provider has no control-message channel', () => {
    const collab = createCollaboration('send-room', 'peer-a');

    expect(collab.sendFollowMessage({ active: false })).toBe(false);
    expect(collab.sendCallMessage({ active: false })).toBe(false);

    collab.destroy();
  });
});

describe('createCollaboration without awareness', () => {
  it('stays inert when the provider carries no awareness', () => {
    const collab = createCollaboration('no-awareness-room', 'peer-a');

    expect(() => collab.setLocalCursor(1, 2)).not.toThrow();
    expect(collab.getLocalCursor()).toBeNull();
    expect(() => collab.setLocalUserName('Ada')).not.toThrow();
    expect(() => collab.destroy()).not.toThrow();
  });
});

describe('createCollaboration destroy', () => {
  it('destroys the provider, document, cursor, timer, and subscribers', () => {
    vi.useFakeTimers();
    try {
      const collab = createCollaboration('destroy-room', 'peer-destroy');
      collab.setLocalCursor(9, 9);
      const awareness = (collab.provider as unknown as { awareness: Awareness }).awareness;
      const statesDuringDestroy: unknown[] = [];
      awareness.on('change', () => statesDuringDestroy.push(awareness.getLocalState()));
      const beforeDestroy: unknown[] = [];
      collab.onChange((type, data) => {
        if (type === 'status') beforeDestroy.push(data);
      });
      beforeDestroy.length = 0;

      collab.destroy();

      expect(collab.doc.isDestroyed).toBe(true);
      expect(destroyProvider).toHaveBeenCalledWith('destroy-room');
      const state = awareness.getLocalState() as { cursor?: unknown } | null;
      expect(state?.cursor ?? null).toBeNull();
      // Withdrawing the cursor is its own awareness change, not just the
      // removal the document teardown performs afterwards.
      expect(statesDuringDestroy).toContainEqual({ cursor: null });

      const connectCalls = vi.mocked(collab.provider.connect).mock.calls.length;
      vi.advanceTimersByTime(10_000);
      expect(vi.mocked(collab.provider.connect).mock.calls.length).toBe(connectCalls);

      statusListeners.forEach((listener) => listener({ status: 'connected' }));
      expect(beforeDestroy).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
