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
      on: () => void;
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
    this.on = vi.fn();
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
  });
});
