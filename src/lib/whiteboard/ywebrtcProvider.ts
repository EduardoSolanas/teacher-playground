import * as Y from 'yjs';

type ProviderLike = {
  connected?: boolean;
  shouldConnect?: boolean;
  connect: () => void;
  destroy: () => void;
  on: (eventName: string, callback: (...args: any[]) => void) => void;
};

type ProviderEntry = { provider: ProviderLike; status: string; synced: boolean };

type SignalingUrlPolicy = {
  production: boolean;
  pageHost?: string;
};

const SIGNALING_PATH = '/signaling';

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

function isProductionBuild(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Store/provider debug handles on `window`. Off in production unless a build flag is set. */
export function isWhiteboardDebugEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.NEXT_PUBLIC_WHITEBOARD_DEBUG === '1' ||
    process.env.NEXT_PUBLIC_E2E === '1'
  );
}

function allowedSignalingHosts(): string[] {
  return (process.env.NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
}

function pageHostFromWindow(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.location.host || window.location.hostname;
}

/**
 * Production: `wss:` only, path `/signaling`, no credentials/fragments/query,
 * and host must be the page origin or `NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS`.
 * Development also allows `ws:` after the same structural checks.
 */
export function sanitizeSignalingUrl(
  raw: string,
  policy: SignalingUrlPolicy,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }

  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.hash !== '') return null;
  if (parsed.search !== '') return null;
  if (parsed.pathname !== SIGNALING_PATH) return null;

  const isWss = parsed.protocol === 'wss:';
  const isWs = parsed.protocol === 'ws:';
  if (!isWss && !isWs) return null;

  if (policy.production) {
    if (!isWss) return null;
    const allowlisted = allowedSignalingHosts();
    const sameOrigin = Boolean(policy.pageHost && parsed.host === policy.pageHost);
    const explicitlyAllowed =
      allowlisted.includes(parsed.host) || allowlisted.includes(parsed.hostname);
    if (!sameOrigin && !explicitlyAllowed) return null;
  }

  return `${parsed.protocol}//${parsed.host}${SIGNALING_PATH}`;
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

  const production = isProductionBuild();
  const pageHost = pageHostFromWindow();
  const policy: SignalingUrlPolicy = { production, pageHost };

  const configured = process.env.NEXT_PUBLIC_YWEBRTC_SIGNALING_URL;
  if (configured) {
    return configured
      .split(',')
      .map((url) => sanitizeSignalingUrl(url, policy))
      .filter((url): url is string => url !== null)
      .map(withRoom);
  }

  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = pageHost ?? window.location.hostname;
    // Same origin only: the Worker serves /signaling alongside the app. The
    // standalone signaling server is opted into via the env vars above.
    return [withRoom(`${protocol}://${host}${SIGNALING_PATH}`)];
  }

  if (production) return [];
  return [withRoom(`ws://localhost:3001${SIGNALING_PATH}`)];
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
