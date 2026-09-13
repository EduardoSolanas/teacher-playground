import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { webrtcCtor, websocketCtor } = vi.hoisted(() => {
  const webrtcCtor = vi.fn();
  const websocketCtor = vi.fn(function WebsocketProviderMock(
    this: {
      connected: boolean;
      shouldConnect: boolean;
      connect: () => void;
      destroy: () => void;
      on: (name: string, callback: (...args: any[]) => void) => void;
      handlers: Record<string, (...args: any[]) => void>;
      doc?: Y.Doc;
      messageHandlers?: any;
    },
    _serverUrl: string,
    _roomname: string,
    doc: Y.Doc,
    options?: { connect?: boolean },
  ) {
    this.connected = false;
    this.shouldConnect = options?.connect !== false;
    this.connect = vi.fn();
    this.destroy = vi.fn();
    this.handlers = {};
    this.on = vi.fn((name: string, callback: (...args: any[]) => void) => {
      this.handlers[name] = callback;
    });
    this.doc = doc;
    this.messageHandlers = [];
  });
  return { webrtcCtor, websocketCtor };
});

vi.mock('y-webrtc', () => ({
  WebrtcProvider: webrtcCtor,
}));

vi.mock('y-websocket', () => ({
  WebsocketProvider: websocketCtor,
}));

import { createYWebsocketProvider, destroyProvider, type WhiteboardProvider } from './yWebsocketProvider';
import { PRESENCE_MESSAGE_TYPE, encodePresenceMessage } from './presenceMessage';
import { FOLLOW_MESSAGE_TYPE, encodeFollowMessage } from './followMessage';
import { CALL_MESSAGE_TYPE, encodeCallMessage } from './callMessage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('createYWebsocketProvider', () => {
  it('does not instantiate WebrtcProvider in the browser', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    createYWebsocketProvider(new Y.Doc(), 'browser-room');

    expect(webrtcCtor).not.toHaveBeenCalled();
    expect(websocketCtor).toHaveBeenCalled();

    destroyProvider('browser-room');
  });

  it('connects the websocket provider in the browser', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    createYWebsocketProvider(new Y.Doc(), 'connect-room');
    const instance = websocketCtor.mock.instances.at(-1) as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };

    expect(websocketCtor).toHaveBeenCalledWith(
      'wss://unused.invalid',
      '_',
      expect.any(Y.Doc),
      expect.objectContaining({ connect: false, disableBc: true }),
    );
    expect(instance?.connect).toHaveBeenCalled();

    destroyProvider('connect-room');
  });
  /**
   * The room owns the Y.Doc, but signaling may shed bursts above its budget.
   * Periodic sync lets a client repair an update the server missed during that
   * window, so the recovery mechanism must stay enabled.
   */
  it('re-sends sync step 1 on an interval so a late joiner cannot leave peers with a causal gap', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    createYWebsocketProvider(new Y.Doc(), 'resync-room');

    const options = websocketCtor.mock.calls.at(-1)?.[3] as { resyncInterval?: number };
    expect(typeof options.resyncInterval).toBe('number');
    expect(options.resyncInterval).toBeGreaterThan(0);
    expect(options.resyncInterval).toBeLessThanOrEqual(5000);

    destroyProvider('resync-room');
  });

  describe('cache invalidation on doc mismatch', () => {
    /**
     * The cache exists to preserve a single socket per room. But if a new
     * collaboration starts with a fresh Y.Doc while the old provider still
     * caches the old doc, the provider's binding is stale: local edits go into
     * the wrong doc, and remote updates land nowhere. The doc identity must be
     * part of cache validity.
     */
    it('returns the same provider instance when called with the same roomId and doc', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const doc = new Y.Doc();
      const entry1 = createYWebsocketProvider(doc, 'same-doc-room');
      const entry2 = createYWebsocketProvider(doc, 'same-doc-room');

      expect(entry1.provider).toBe(entry2.provider);
      expect(websocketCtor).toHaveBeenCalledTimes(1);

      destroyProvider('same-doc-room');
    });

    it('returns different provider instances when called with the same roomId but different docs, and destroys the superseded provider', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const doc1 = new Y.Doc();
      const doc2 = new Y.Doc();

      const entry1 = createYWebsocketProvider(doc1, 'diff-doc-room');
      const firstInstance = websocketCtor.mock.instances.at(-1) as any;
      const firstDestroyFn = firstInstance?.destroy as any;

      const entry2 = createYWebsocketProvider(doc2, 'diff-doc-room');
      const secondInstance = websocketCtor.mock.instances.at(-1) as any;

      expect(entry1.provider).not.toBe(entry2.provider);
      expect(firstDestroyFn).toHaveBeenCalled();
      expect(websocketCtor).toHaveBeenCalledTimes(2);

      destroyProvider('diff-doc-room');
    });
  });

  describe('presence message handler', () => {
    /**
     * y-websocket invokes message handlers as handler(encoder, decoder, provider, emitSynced, messageType),
     * having already consumed the message type varint. The handler must read the body directly from
     * the decoder, not re-parse a whole frame.
     */
    it('delivers presence messages via the handler when invoked with y-websocket dispatch signature', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const presencePayload = {
        users: [{ peerId: 'peer1', userName: 'User 1', color: '#ff0000' }],
        hostPeerId: 'peer0',
      };

      const onPresence = vi.fn();
      const doc = new Y.Doc();
      const entry = createYWebsocketProvider(doc, 'presence-room', onPresence);

      const provider: WhiteboardProvider = entry.provider;
      expect(provider.messageHandlers).toBeDefined();

      // Build the presence frame exactly as encodePresenceMessage does
      const frame = encodePresenceMessage(presencePayload);

      // Create a decoder over the frame and consume the type varint (as y-websocket does before dispatch)
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);

      expect(messageType).toBe(PRESENCE_MESSAGE_TYPE);

      // Now dispatch to the handler as y-websocket does: (encoder, decoder, provider, emitSynced, messageType)
      // The decoder now points at the body (type varint already consumed)
      const encoder = encoding.createEncoder();
      const handler = provider.messageHandlers?.[PRESENCE_MESSAGE_TYPE];
      expect(handler).toBeDefined();
      handler?.(encoder, decoder);

      expect(onPresence).toHaveBeenCalledWith(presencePayload);

      destroyProvider('presence-room');
    });

    it('updates the presence handler on cache hit when called with a different callback', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const presencePayload = {
        users: [{ peerId: 'peer1', userName: 'User 1', color: '#ff0000' }],
        hostPeerId: 'peer0',
      };

      const onPresence1 = vi.fn();
      const onPresence2 = vi.fn();
      const doc = new Y.Doc();

      // First call with onPresence1
      const entry1 = createYWebsocketProvider(doc, 'presence-cache-room', onPresence1);
      const provider = entry1.provider;

      // Second call with onPresence2 for same room and doc
      const entry2 = createYWebsocketProvider(doc, 'presence-cache-room', onPresence2);

      // The returned provider should be the same cached instance
      expect(entry2.provider).toBe(provider);

      // Build the presence frame
      const frame = encodePresenceMessage(presencePayload);
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);

      expect(messageType).toBe(PRESENCE_MESSAGE_TYPE);

      // Dispatch to the handler
      const encoder = encoding.createEncoder();
      const handler = provider.messageHandlers?.[PRESENCE_MESSAGE_TYPE];
      expect(handler).toBeDefined();
      handler?.(encoder, decoder);

      // The second callback should receive the message, the first should not
      expect(onPresence2).toHaveBeenCalledWith(presencePayload);
      expect(onPresence1).not.toHaveBeenCalled();

      destroyProvider('presence-cache-room');
    });

    it('updates the follow handler on cache hit when called with a different callback', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const followPayload = { active: true, viewport: { x: 100, y: 200, zoom: 1.5 } };

      const onFollow1 = vi.fn();
      const onFollow2 = vi.fn();
      const doc = new Y.Doc();

      // First call with onFollow1
      const entry1 = createYWebsocketProvider(doc, 'follow-cache-room', undefined, onFollow1);
      const provider = entry1.provider;

      // Second call with onFollow2 for same room and doc
      const entry2 = createYWebsocketProvider(doc, 'follow-cache-room', undefined, onFollow2);

      // The returned provider should be the same cached instance
      expect(entry2.provider).toBe(provider);

      // Build the follow frame
      const frame = encodeFollowMessage(followPayload);
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);

      expect(messageType).toBe(FOLLOW_MESSAGE_TYPE);

      // Dispatch to the handler
      const encoder = encoding.createEncoder();
      const handler = provider.messageHandlers?.[FOLLOW_MESSAGE_TYPE];
      expect(handler).toBeDefined();
      handler?.(encoder, decoder);

      // The second callback should receive the message, the first should not
      expect(onFollow2).toHaveBeenCalledWith(followPayload);
      expect(onFollow1).not.toHaveBeenCalled();

      destroyProvider('follow-cache-room');
    });

    it('clears a handler slot when a second call passes undefined for that callback', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const presencePayload = {
        users: [{ peerId: 'peer1', userName: 'User 1', color: '#ff0000' }],
        hostPeerId: 'peer0',
      };

      const onPresence = vi.fn();
      const doc = new Y.Doc();

      // First call with onPresence handler
      const entry1 = createYWebsocketProvider(doc, 'clear-handler-room', onPresence);
      const provider = entry1.provider;

      // Second call with undefined for onPresence (clear the slot)
      const entry2 = createYWebsocketProvider(doc, 'clear-handler-room', undefined);

      // The returned provider should be the same cached instance
      expect(entry2.provider).toBe(provider);

      // Build the presence frame
      const frame = encodePresenceMessage(presencePayload);
      const decoder = decoding.createDecoder(frame);
      const messageType = decoding.readVarUint(decoder);

      expect(messageType).toBe(PRESENCE_MESSAGE_TYPE);

      // Try to dispatch to the handler
      const encoder = encoding.createEncoder();
      const handler = provider.messageHandlers?.[PRESENCE_MESSAGE_TYPE];
      // The handler should be undefined now
      expect(handler).toBeUndefined();
      // Calling it should not crash and should not call the original callback
      handler?.(encoder, decoder);
      expect(onPresence).not.toHaveBeenCalled();

      destroyProvider('clear-handler-room');
    });

    it('does not create a second provider when called multiple times with the same room and doc', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const onPresence1 = vi.fn();
      const onPresence2 = vi.fn();
      const onPresence3 = vi.fn();
      const doc = new Y.Doc();

      // Multiple calls with different callbacks
      const entry1 = createYWebsocketProvider(doc, 'multi-call-room', onPresence1);
      const entry2 = createYWebsocketProvider(doc, 'multi-call-room', onPresence2);
      const entry3 = createYWebsocketProvider(doc, 'multi-call-room', onPresence3);

      // All should return the same provider instance
      expect(entry2.provider).toBe(entry1.provider);
      expect(entry3.provider).toBe(entry1.provider);

      // All should return the same ProviderEntry (cached object)
      expect(entry2).toBe(entry1);
      expect(entry3).toBe(entry1);

      // WebsocketProvider should have been instantiated only once
      expect(websocketCtor).toHaveBeenCalledTimes(1);

      destroyProvider('multi-call-room');
    });
  });

  describe('server stub and entry state', () => {
    it('uses the server stub without touching the websocket provider when there is no window', () => {
      vi.stubGlobal('window', undefined);

      const entry = createYWebsocketProvider(new Y.Doc(), 'server-room');

      expect(websocketCtor).not.toHaveBeenCalled();
      expect(entry.provider.wsconnected).toBe(false);
      expect(entry.provider.shouldConnect).toBe(false);
      expect(entry.provider.awareness).toBeDefined();
      expect(entry.status).toBe('connecting');
      expect(entry.synced).toBe(false);

      destroyProvider('server-room');
    });

    it('tracks status and synced from provider events', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const entry = createYWebsocketProvider(new Y.Doc(), 'events-room');
      const instance = websocketCtor.mock.instances.at(-1) as unknown as {
        handlers: Record<string, (...args: any[]) => void>;
      };

      expect(entry.status).toBe('connecting');
      expect(entry.synced).toBe(false);

      instance.handlers.status({ connected: true });
      expect(entry.status).toBe('connected');

      instance.handlers.status({ status: 'connected' });
      expect(entry.status).toBe('connected');

      instance.handlers.status({ connected: false });
      expect(entry.status).toBe('disconnected');

      instance.handlers.synced(true);
      expect(entry.synced).toBe(true);
      expect(entry.status).toBe('synced');

      instance.handlers.status({ connected: true });
      instance.handlers.synced({ synced: false });
      expect(entry.synced).toBe(false);
      expect(entry.provider.synced).toBe(false);
      expect(entry.status).toBe('connected');

      destroyProvider('events-room');
    });

    it('falls back to an empty signaling URL when every configured URL is rejected', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_URL', 'ws://whiteboard.example.com/signaling');

      createYWebsocketProvider(new Y.Doc(), 'unsafe-signaling-room');
      const instance = websocketCtor.mock.instances.at(-1) as unknown as { url: string };

      expect(instance.url).toBe('');

      destroyProvider('unsafe-signaling-room');
    });

    it('keys the cache by room, not only by doc', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const doc = new Y.Doc();
      const first = createYWebsocketProvider(doc, 'room-a');
      const second = createYWebsocketProvider(doc, 'room-b');

      expect(second).not.toBe(first);

      destroyProvider('room-a');
      destroyProvider('room-b');
    });

    it('destroys the cached provider and builds a fresh one afterwards', () => {
      vi.stubGlobal('window', {
        location: {
          protocol: 'https:',
          hostname: 'whiteboard.example.com',
          host: 'whiteboard.example.com',
        },
      });

      const doc = new Y.Doc();
      const first = createYWebsocketProvider(doc, 'destroy-room');
      const instance = websocketCtor.mock.instances.at(-1) as unknown as {
        connect: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      expect(instance.connect).toHaveBeenCalled();

      destroyProvider('destroy-room');
      expect(instance.destroy).toHaveBeenCalled();

      const second = createYWebsocketProvider(doc, 'destroy-room');
      expect(second).not.toBe(first);

      destroyProvider('destroy-room');
    });

    it('destroyProvider ignores a room that was never created', () => {
      expect(() => destroyProvider('never-created')).not.toThrow();
    });
  });

  describe('message handler edge cases', () => {
    const windowStub = {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    };

    it('clears the follow and call slots when a remount omits them', () => {
      vi.stubGlobal('window', windowStub);

      const doc = new Y.Doc();
      const entry = createYWebsocketProvider(doc, 'slot-room', undefined, vi.fn(), vi.fn());
      const provider = entry.provider;
      expect(provider.messageHandlers?.[FOLLOW_MESSAGE_TYPE]).toBeDefined();
      expect(provider.messageHandlers?.[CALL_MESSAGE_TYPE]).toBeDefined();

      createYWebsocketProvider(doc, 'slot-room');

      expect(provider.messageHandlers?.[FOLLOW_MESSAGE_TYPE]).toBeUndefined();
      expect(provider.messageHandlers?.[CALL_MESSAGE_TYPE]).toBeUndefined();

      destroyProvider('slot-room');
    });

    it('ignores a malformed presence frame', () => {
      vi.stubGlobal('window', windowStub);

      const onPresence = vi.fn();
      const entry = createYWebsocketProvider(new Y.Doc(), 'bad-presence-room', onPresence);
      const provider = entry.provider;
      const decoder = decoding.createDecoder(new Uint8Array([PRESENCE_MESSAGE_TYPE]));

      provider.messageHandlers?.[PRESENCE_MESSAGE_TYPE]?.(encoding.createEncoder(), decoder);

      expect(onPresence).not.toHaveBeenCalled();

      destroyProvider('bad-presence-room');
    });

    it('ignores a malformed follow frame', () => {
      vi.stubGlobal('window', windowStub);

      const onFollow = vi.fn();
      const entry = createYWebsocketProvider(new Y.Doc(), 'bad-follow-room', undefined, onFollow);
      const provider = entry.provider;
      const decoder = decoding.createDecoder(new Uint8Array([FOLLOW_MESSAGE_TYPE]));

      provider.messageHandlers?.[FOLLOW_MESSAGE_TYPE]?.(encoding.createEncoder(), decoder);

      expect(onFollow).not.toHaveBeenCalled();

      destroyProvider('bad-follow-room');
    });

    it('delivers call messages and ignores malformed call frames', () => {
      vi.stubGlobal('window', windowStub);

      const onCall = vi.fn();
      const entry = createYWebsocketProvider(
        new Y.Doc(),
        'call-room',
        undefined,
        undefined,
        onCall,
      );
      const provider = entry.provider;
      const state = { active: true as const, hostAccountId: 'acc-1', startedAt: 123 };
      const decoder = decoding.createDecoder(encodeCallMessage(state));
      expect(decoding.readVarUint(decoder)).toBe(CALL_MESSAGE_TYPE);

      provider.messageHandlers?.[CALL_MESSAGE_TYPE]?.(encoding.createEncoder(), decoder);
      expect(onCall).toHaveBeenCalledWith(state);

      const badDecoder = decoding.createDecoder(new Uint8Array([CALL_MESSAGE_TYPE]));
      provider.messageHandlers?.[CALL_MESSAGE_TYPE]?.(encoding.createEncoder(), badDecoder);
      expect(onCall).toHaveBeenCalledTimes(1);

      destroyProvider('call-room');
    });
  });
});
