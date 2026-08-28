import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { getSignalingUrls } from './ywebrtcProvider';
import { PRESENCE_MESSAGE_TYPE, readPresenceBody } from './presenceMessage';

type ProviderLike = {
  connected?: boolean;
  shouldConnect?: boolean;
  synced?: boolean;
  doc?: Y.Doc;
  /** Ephemeral peer state (cursors). Absent on the server stub. */
  awareness?: Awareness;
  connect: () => void;
  destroy: () => void;
  on: (eventName: string, callback: (...args: any[]) => void) => void;
};

type ProviderEntry = { provider: ProviderLike; status: string; synced: boolean };

let providerCache: Map<string, ProviderEntry> = new Map();

/**
 * Stands in where there is no socket: server rendering, and unit tests.
 *
 * It still carries a real Awareness. Cursors are published through awareness
 * now, and a provider that omitted it would make the cursor API silently do
 * nothing off the browser -- present in the type, absent in practice.
 */
function createServerProvider(doc: Y.Doc): ProviderLike {
  return {
    connected: false,
    shouldConnect: false,
    awareness: new Awareness(doc),
    connect: () => {},
    destroy: () => {},
    on: () => {},
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

export function createYWebsocketProvider(
  doc: Y.Doc,
  roomId: string,
  onPresence?: PresenceCallback,
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

  const provider: ProviderLike = typeof window === 'undefined'
    ? createServerProvider(doc)
    : new SignalingWebsocketProvider(doc, roomId) as unknown as ProviderLike;

  provider.doc = doc;

  const entry = { provider, status: 'connecting', synced: false };
  providerCache.set(cacheKey, entry);

  provider.on('status', (event: { status?: string; connected?: boolean }) => {
    const connected = event.status === 'connected' || event.connected === true;
    entry.status = connected ? 'connected' : 'disconnected';
  });
  provider.on('synced', (event: boolean | { synced: boolean }) => {
    const synced = typeof event === 'boolean' ? event : event.synced;
    entry.synced = synced;
    (provider as ProviderLike).synced = synced;
    if (synced) entry.status = 'synced';
  });

  // Register presence message handler
  if (onPresence && typeof window !== 'undefined') {
    const wsProvider = provider as any;
    if (wsProvider.messageHandlers && Array.isArray(wsProvider.messageHandlers)) {
      // y-websocket invokes handlers as handler(encoder, decoder, provider, emitSynced, messageType),
      // having already consumed the message type varint. Read the body from the decoder, not a whole frame.
      wsProvider.messageHandlers[PRESENCE_MESSAGE_TYPE] = (_encoder: any, decoder: any) => {
        const payload = readPresenceBody(decoder);
        if (payload !== null) {
          onPresence(payload);
        }
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
