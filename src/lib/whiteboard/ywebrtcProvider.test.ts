import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createYWebRTCProvider,
  destroyProvider,
  getSignalingUrls,
  isWhiteboardDebugEnabled,
  sanitizeSignalingUrl,
} from './ywebrtcProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubHttpsPage() {
  vi.stubGlobal('window', {
    location: {
      protocol: 'https:',
      hostname: 'whiteboard.example.com',
      host: 'whiteboard.example.com',
    },
  });
}

describe('getSignalingUrls', () => {
  it('uses the browser host for the default signaling URL', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'http:',
        hostname: '192.168.1.50',
        host: '192.168.1.50:3000',
      },
    });

    expect(getSignalingUrls()).toEqual(['ws://192.168.1.50:3000/signaling']);
  });

  it('uses wss when the page is served over https', () => {
    stubHttpsPage();

    expect(getSignalingUrls()).toEqual(['wss://whiteboard.example.com/signaling']);
  });

  it('allows explicit development signaling URLs that use /signaling', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(
      'NEXT_PUBLIC_YWEBRTC_SIGNALING_URL',
      'wss://one.example.com/signaling, ws://two.example.com/signaling',
    );

    expect(getSignalingUrls()).toEqual([
      'wss://one.example.com/signaling',
      'ws://two.example.com/signaling',
    ]);
  });

  it('puts the room on the signaling URL so the Worker can route the socket', () => {
    stubHttpsPage();

    expect(getSignalingUrls('math-101')).toEqual([
      'wss://whiteboard.example.com/signaling?room=math-101',
    ]);
  });

  it('encodes a room id that needs escaping', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'example.com',
        host: 'example.com',
      },
    });

    expect(getSignalingUrls('a b&c')).toEqual([
      'wss://example.com/signaling?room=a%20b%26c',
    ]);
  });

  it('appends the room to explicitly configured signaling URLs', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(
      'NEXT_PUBLIC_YWEBRTC_SIGNALING_URL',
      'wss://one.example.com/signaling, ws://two.example.com/signaling',
    );

    expect(getSignalingUrls('r1')).toEqual([
      'wss://one.example.com/signaling?room=r1',
      'ws://two.example.com/signaling?room=r1',
    ]);
  });

  it('does not initialize WebRTC on the server', () => {
    vi.stubGlobal('window', undefined);

    const entry = createYWebRTCProvider(new Y.Doc(), 'server-render-room');

    expect(entry.provider.connected).toBe(false);
    expect(entry.provider.shouldConnect).toBe(false);
    expect(() => entry.provider.connect()).not.toThrow();

    destroyProvider('server-render-room');
  });
});

describe('production signaling URL policy', () => {
  it('rejects ws:, credentials, fragments, unexpected paths, and extra query', () => {
    const policy = { production: true, pageHost: 'whiteboard.example.com' };

    expect(sanitizeSignalingUrl('ws://whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://user:pass@whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/signaling#frag', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/other', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/signaling?x=1', policy)).toBeNull();
    expect(sanitizeSignalingUrl('https://whiteboard.example.com/signaling', policy)).toBeNull();
  });

  it('rejects non-allowlisted hosts even when the rest of the URL is well-formed', () => {
    const policy = { production: true, pageHost: 'whiteboard.example.com' };

    expect(sanitizeSignalingUrl('wss://evil.example/signaling', policy)).toBeNull();
  });

  it('accepts same-origin wss /signaling', () => {
    expect(
      sanitizeSignalingUrl('wss://whiteboard.example.com/signaling', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://whiteboard.example.com/signaling');
  });

  it('accepts an explicitly allowlisted wss host', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS', 'signals.example.com');

    expect(
      sanitizeSignalingUrl('wss://signals.example.com/signaling', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://signals.example.com/signaling');
  });

  it('fails closed when every configured production URL is unsafe', () => {
    stubHttpsPage();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'NEXT_PUBLIC_YWEBRTC_SIGNALING_URL',
      'ws://whiteboard.example.com/signaling, wss://user:secret@whiteboard.example.com/signaling, wss://whiteboard.example.com/admin#x',
    );

    expect(getSignalingUrls('room-1')).toEqual([]);
  });

  it('keeps only allowlisted production endpoints from a mixed list', () => {
    stubHttpsPage();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'NEXT_PUBLIC_YWEBRTC_SIGNALING_URL',
      'wss://evil.example/signaling, wss://whiteboard.example.com/signaling, ws://whiteboard.example.com/signaling',
    );

    expect(getSignalingUrls()).toEqual(['wss://whiteboard.example.com/signaling']);
  });
});

describe('isWhiteboardDebugEnabled', () => {
  it('is off for a production-like build without an explicit flag', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WHITEBOARD_DEBUG', '');
    vi.stubEnv('NEXT_PUBLIC_E2E', '');

    expect(isWhiteboardDebugEnabled()).toBe(false);
  });

  it('is on in development', () => {
    vi.stubEnv('NODE_ENV', 'development');

    expect(isWhiteboardDebugEnabled()).toBe(true);
  });

  it('is on when NEXT_PUBLIC_WHITEBOARD_DEBUG=1 even in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WHITEBOARD_DEBUG', '1');

    expect(isWhiteboardDebugEnabled()).toBe(true);
  });
});
