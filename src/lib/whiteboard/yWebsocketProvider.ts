import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { getSignalingUrls } from './ywebrtcProvider';
import {
  PRESENCE_MESSAGE_TYPE,
  decodePresenceMessagePayload,
} from './presenceMessage';
import {
  FOLLOW_MESSAGE_TYPE,
  decodeFollowMessagePayload,
  encodeFollowMessage,
  type FollowMessage,
} from './followMessage';

type ProviderLike = {
  connected?: boolean;
  shouldConnect?: boolean;
  synced?: boolean;
  connect: () => void;
  destroy: () => void;
  sendFollowMessage?: (message: FollowMessage) => boolean;
  on: (eventName: string, callback: (...args: any[]) => void) => void;
};

type ProviderEntry = {
  provider: ProviderLike;
  status: string;
  synced: boolean;
  sendFollowMessage: (message: FollowMessage) => boolean;
};

let providerCache: Map<string, ProviderEntry> = new Map();

function createServerProvider(): ProviderLike {
  return {
    connected: false,
    shouldConnect: false,
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
export type FollowCallback = (payload: FollowMessage) => void;

export function createYWebsocketProvider(
  doc: Y.Doc,
  roomId: string,
  onPresence?: PresenceCallback,
  onFollow?: FollowCallback,
): ProviderEntry {
  const cacheKey = `whiteboard-${roomId}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const provider: ProviderLike = typeof window === 'undefined'
    ? createServerProvider()
    : new SignalingWebsocketProvider(doc, roomId) as unknown as ProviderLike;

  const entry: ProviderEntry = {
    provider,
    status: 'connecting',
    synced: false,
    sendFollowMessage: (message) => {
      if (typeof window === 'undefined') return false;
      const ws = (provider as any).ws as WebSocket | null | undefined;
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
    (provider as ProviderLike).synced = synced;
    if (synced) entry.status = 'synced';
  });

  // Register presence message handler
  if (onPresence && typeof window !== 'undefined') {
    const wsProvider = provider as any;
    if (wsProvider.messageHandlers && Array.isArray(wsProvider.messageHandlers)) {
      wsProvider.messageHandlers[PRESENCE_MESSAGE_TYPE] = (_encoder: unknown, decoder: any) => {
        const payload = decodePresenceMessagePayload(decoder);
        if (payload !== null) {
          onPresence(payload);
        }
      };
    }
  }

  if (onFollow && typeof window !== 'undefined') {
    const wsProvider = provider as any;
    if (wsProvider.messageHandlers && Array.isArray(wsProvider.messageHandlers)) {
      wsProvider.messageHandlers[FOLLOW_MESSAGE_TYPE] = (_encoder: unknown, decoder: any) => {
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
