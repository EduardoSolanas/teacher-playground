import * as Y from 'yjs';

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

/**
 * When `roomId` is given, each URL carries `?room=<roomId>`. The Cloudflare
 * Worker routes a signaling socket to that room's Durable Object before any
 * protocol message arrives, so the room has to be on the URL itself.
 */
export function getSignalingUrls(roomId?: string): string[] {
  const withRoom = (url: string): string => {
    if (!roomId) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}room=${encodeURIComponent(roomId)}`;
  };

  const configured = process.env.NEXT_PUBLIC_YWEBRTC_SIGNALING_URL;
  if (configured) {
    return configured
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean)
      .map(withRoom);
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = window.location.host || window.location.hostname;
    // Same origin only: the Worker serves /signaling alongside the app. The
    // standalone dev signaling server is opted into via the env var above.
    return [withRoom(`${protocol}://${host}/signaling`)];
  }

  return [withRoom('ws://localhost:3001')];
}

export function createYWebRTCProvider(
  doc: Y.Doc,
  roomId: string
): ProviderEntry {
  const cacheKey = `whiteboard-${roomId}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const provider = typeof window === 'undefined'
    ? createServerProvider()
    : new (require('y-webrtc').WebrtcProvider)(
        cacheKey,
        doc,
        {
          filterBcConns: false,
          signaling: getSignalingUrls(roomId),
        }
      );

  const entry = { provider, status: 'connecting', synced: false };
  providerCache.set(cacheKey, entry);

  provider.on('status', (event: { connected: boolean }) => {
    entry.status = event.connected ? 'connected' : 'disconnected';
  });
  provider.on('synced', (event: { synced: boolean }) => {
    entry.synced = event.synced;
    if (event.synced) entry.status = 'synced';
  });

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
