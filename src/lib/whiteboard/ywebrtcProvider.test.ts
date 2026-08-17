import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';
import { createYWebRTCProvider, destroyProvider, getSignalingUrls } from './ywebrtcProvider';

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

    vi.unstubAllGlobals();
  });

  it('uses wss when the page is served over https', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    expect(getSignalingUrls()).toEqual(['wss://whiteboard.example.com/signaling']);

    vi.unstubAllGlobals();
  });

  it('allows explicit signaling URLs from the environment', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_URL', 'wss://one.example.com, ws://two.example.com');

    expect(getSignalingUrls()).toEqual(['wss://one.example.com', 'ws://two.example.com']);

    vi.unstubAllEnvs();
  });

  it('puts the room on the signaling URL so the Worker can route the socket', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    expect(getSignalingUrls('math-101')).toEqual([
      'wss://whiteboard.example.com/signaling?room=math-101',
    ]);

    vi.unstubAllGlobals();
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

    vi.unstubAllGlobals();
  });

  it('appends the room to explicitly configured signaling URLs', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_URL', 'wss://one.example.com, ws://two.example.com/path?x=1');

    expect(getSignalingUrls('r1')).toEqual([
      'wss://one.example.com?room=r1',
      'ws://two.example.com/path?x=1&room=r1',
    ]);

    vi.unstubAllEnvs();
  });

  it('does not initialize WebRTC on the server', () => {
    vi.stubGlobal('window', undefined);

    const entry = createYWebRTCProvider(new Y.Doc(), 'server-render-room');

    expect(entry.provider.connected).toBe(false);
    expect(entry.provider.shouldConnect).toBe(false);
    expect(() => entry.provider.connect()).not.toThrow();

    destroyProvider('server-render-room');
    vi.unstubAllGlobals();
  });
});
