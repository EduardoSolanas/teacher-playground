import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { getSignalingUrls } from './ywebrtcProvider';

type ProviderLike = {
  connected?: boolean;
  shouldConnect?: boolean;
  connect: () => void;
  destroy: () => void;
  on: (eventName: string, callback: (...args: any[]) => void) => void;
};

type ProviderEntry = { provider: ProviderLike; status: string; synced: boolean };

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

/** Points y-websocket at the Worker's `/signaling?room=…` URL instead of `/signaling/<doc>`. */
class SignalingWebsocketProvider extends WebsocketProvider {
  private readonly signalingUrl: string;

  constructor(doc: Y.Doc, roomId: string) {
    super('wss://unused.invalid', '_', doc, { disableBc: true });
    const urls = getSignalingUrls(roomId);
    this.signalingUrl = urls[0] ?? '';
  }

  override get url(): string {
    return this.signalingUrl;
  }
}

export function createYWebsocketProvider(doc: Y.Doc, roomId: string): ProviderEntry {
  const cacheKey = `whiteboard-${roomId}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const provider: ProviderLike = typeof window === 'undefined'
    ? createServerProvider()
    : new SignalingWebsocketProvider(doc, roomId) as unknown as ProviderLike;

  const entry = { provider, status: 'connecting', synced: false };
  providerCache.set(cacheKey, entry);

  provider.on('status', (event: { status?: string; connected?: boolean }) => {
    const connected = event.status === 'connected' || event.connected === true;
    entry.status = connected ? 'connected' : 'disconnected';
  });
  provider.on('synced', (event: boolean | { synced: boolean }) => {
    const synced = typeof event === 'boolean' ? event : event.synced;
    entry.synced = synced;
    if (synced) entry.status = 'synced';
  });

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
