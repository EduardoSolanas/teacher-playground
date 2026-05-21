import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';

let providerCache: Map<string, { provider: WebrtcProvider; status: string; synced: boolean }> = new Map();

export function createYWebRTCProvider(
  doc: Y.Doc,
  roomId: string
): { provider: WebrtcProvider; status: string; synced: boolean } {
  const cacheKey = `${roomId}`;

  if (providerCache.has(cacheKey)) {
    return providerCache.get(cacheKey)!;
  }

  const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
  const signalingUrl = `${protocol}://${host}/signaling`;

  const provider = new WebrtcProvider(
    `whiteboard-${roomId}`,
    doc,
    {
      signaling: [signalingUrl],
      filterBcConns: false,
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
  const cacheKey = `${roomId}`;
  const cached = providerCache.get(cacheKey);
  if (cached) {
    cached.provider.destroy();
    providerCache.delete(cacheKey);
  }
}
