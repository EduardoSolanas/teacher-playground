import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { getSignalingUrls } from './ywebrtcProvider';
import { PRESENCE_MESSAGE_TYPE, readPresenceBody } from './presenceMessage';
import {
  FOLLOW_MESSAGE_TYPE,
  decodeFollowMessagePayload,
  encodeFollowMessage,
  type FollowMessage,
} from './followMessage';

export interface WhiteboardProvider {
  /*
   * `wsconnected` and no `connected`.
   *
   * y-websocket carries `wsconnected`; nothing ever sets `connected` on a real
   * provider. While the seam was typed loosely a `provider.connected === true`
   * check compiled and read `undefined === true` -- false forever, on a healthy
   * socket. Declaring only the property that exists is what stops that being
   * writable again; ask `isYjsProviderConnected`, never a field directly.
   */
  wsconnected?: boolean;
  shouldConnect?: boolean;
  synced?: boolean;
  doc?: Y.Doc;
  /** Ephemeral peer state (cursors). Absent on the server stub. */
  awareness?: Awareness;
  ws?: WebSocket | null;
  messageHandlers?: Array<((encoder: unknown, decoder: any) => void) | undefined>;
  connect: () => void;
  disconnect?: () => void;
  destroy: () => void;
  sendFollowMessage?: (message: FollowMessage) => boolean;
  on: (eventName: string, callback: (...args: any[]) => void) => void;
  off?: (eventName: string, callback: (...args: any[]) => void) => void;
}

export type ProviderEntry = {
  provider: WhiteboardProvider;
  status: string;
  synced: boolean;
  sendFollowMessage: (message: FollowMessage) => boolean;
};

let providerCache: Map<string, ProviderEntry> = new Map();

/**
 * Stands in where there is no socket: server rendering, and unit tests.
 *
 * It still carries a real Awareness. Cursors are published through awareness
 * now, and a provider that omitted it would make the cursor API silently do
 * nothing off the browser -- present in the type, absent in practice.
 */
function createServerProvider(doc: Y.Doc): WhiteboardProvider {
  return {
    wsconnected: false,
    shouldConnect: false,
    awareness: new Awareness(doc),
    connect: () => {},
    disconnect: () => {},
    destroy: () => {},
    on: () => {},
    off: () => {},
  };
}

/**
 * The room's Durable Object owns the authoritative Y.Doc, but signaling can
 * shed bursts above its per-account budget. Re-issuing sync step 1 lets the
 * client send any update the server missed during that shed window. Three
 * seconds bounds the repair delay without adding traffic to the live path.
 */
const RESYNC_INTERVAL_MS = 3_000;

/** Points y-websocket at the Worker's `/signaling?room=…` URL instead of `/signaling/<doc>`. */
class SignalingWebsocketProvider extends WebsocketProvider {
  private readonly signalingUrl: string;

  constructor(doc: Y.Doc, roomId: string) {
    super('wss://unused.invalid', '_', doc, {
      disableBc: true,
      connect: false,
      resyncInterval: RESYNC_INTERVAL_MS,
    });
    const urls = getSignalingUrls(roomId);
    this.signalingUrl = urls[0] ?? '';
    this.shouldConnect = true;
  }

  override get url(): string {
    return this.signalingUrl;
  }
}

export type PresenceCallback = (payload: unknown) => void;
export type FollowCallback = (payload: FollowMessage) => void;

export function createYWebsocketProvider(
  doc: Y.Doc,
  roomId: string,
  onPresence?: PresenceCallback,
  onFollow?: FollowCallback,
): ProviderEntry {
  const cacheKey = `whiteboard-${roomId}`;

  if (providerCache.has(cacheKey)) {
    const cached = providerCache.get(cacheKey)!;
    // A stale binding is silent: local edits go into the wrong doc, remote updates
    // land nowhere. The doc identity must be part of cache validity.
    if (cached.provider.doc === doc) {
      return cached;
    }
    // Doc mismatch: the cached provider is bound to a dead doc. Destroy it and
    // fall through to create a fresh provider for the requested doc.
    cached.provider.destroy();
    providerCache.delete(cacheKey);
  }

  const provider: WhiteboardProvider = typeof window === 'undefined'
    ? createServerProvider(doc)
    : (new SignalingWebsocketProvider(doc, roomId) as unknown as WhiteboardProvider);

  // Kept from the doc-identity fix: the server stub has no `doc` of its own,
  // and cache validity is checked against it above.
  provider.doc = doc;

  const entry: ProviderEntry = {
    provider,
    status: 'connecting',
    synced: false,
    sendFollowMessage: (message) => {
      if (typeof window === 'undefined') return false;
      const ws = provider.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(encodeFollowMessage(message) as unknown as ArrayBuffer);
      return true;
    },
  };
  providerCache.set(cacheKey, entry);

  provider.on('status', (event: { status?: string; connected?: boolean }) => {
    const connected = event.status === 'connected' || event.connected === true;
    entry.status = connected ? 'connected' : 'disconnected';
  });
  provider.on('synced', (event: boolean | { synced: boolean }) => {
    const synced = typeof event === 'boolean' ? event : event.synced;
    entry.synced = synced;
    provider.synced = synced;
    if (synced) entry.status = 'synced';
  });

  // Register presence message handler
  if (onPresence && typeof window !== 'undefined') {
    if (provider.messageHandlers && Array.isArray(provider.messageHandlers)) {
      // y-websocket invokes handlers as handler(encoder, decoder, provider, emitSynced, messageType),
      // having already consumed the message type varint. Read the body from the decoder, not a whole frame.
      provider.messageHandlers[PRESENCE_MESSAGE_TYPE] = (_encoder: unknown, decoder: any) => {
        const payload = readPresenceBody(decoder);
        if (payload !== null) {
          onPresence(payload);
        }
      };
    }
  }

  if (onFollow && typeof window !== 'undefined') {
    if (provider.messageHandlers && Array.isArray(provider.messageHandlers)) {
      provider.messageHandlers[FOLLOW_MESSAGE_TYPE] = (_encoder: unknown, decoder: any) => {
        const payload = decodeFollowMessagePayload(decoder);
        if (payload) onFollow(payload);
      };
    }
  }

  if (typeof window !== 'undefined' && provider.shouldConnect !== false) {
    provider.connect();
  }

  return entry;
}

export function destroyProvider(roomId: string) {
  const cacheKey = `whiteboard-${roomId}`;
  const cached = providerCache.get(cacheKey);
  if (cached) {
    cached.provider.destroy();
    providerCache.delete(cacheKey);
  }
}
