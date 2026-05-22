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

    expect(getSignalingUrls()).toEqual(['ws://192.168.1.50:3000/signaling', 'ws://192.168.1.50:3001']);

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

    expect(getSignalingUrls()).toEqual(['wss://whiteboard.example.com/signaling', 'wss://whiteboard.example.com:3001']);

    vi.unstubAllGlobals();
  });

  it('allows explicit signaling URLs from the environment', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_URL', 'wss://one.example.com, ws://two.example.com');

    expect(getSignalingUrls()).toEqual(['wss://one.example.com', 'ws://two.example.com']);

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
