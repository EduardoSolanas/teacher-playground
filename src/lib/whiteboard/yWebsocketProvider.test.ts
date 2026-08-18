import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { webrtcCtor, websocketCtor } = vi.hoisted(() => {
  const webrtcCtor = vi.fn();
  const websocketCtor = vi.fn(function WebsocketProviderMock(
    this: {
      connected: boolean;
      shouldConnect: boolean;
      connect: () => void;
      destroy: () => void;
      on: () => void;
    },
    _serverUrl: string,
    _roomname: string,
    _doc: Y.Doc,
    options?: { connect?: boolean },
  ) {
    this.connected = false;
    this.shouldConnect = options?.connect !== false;
    this.connect = vi.fn();
    this.destroy = vi.fn();
    this.on = vi.fn();
  });
  return { webrtcCtor, websocketCtor };
});

vi.mock('y-webrtc', () => ({
  WebrtcProvider: webrtcCtor,
}));

vi.mock('y-websocket', () => ({
  WebsocketProvider: websocketCtor,
}));

import { createYWebsocketProvider, destroyProvider } from './yWebsocketProvider';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('createYWebsocketProvider', () => {
  it('does not instantiate WebrtcProvider in the browser', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    createYWebsocketProvider(new Y.Doc(), 'browser-room');

    expect(webrtcCtor).not.toHaveBeenCalled();
    expect(websocketCtor).toHaveBeenCalled();

    destroyProvider('browser-room');
  });

  it('connects the websocket provider in the browser', () => {
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        hostname: 'whiteboard.example.com',
        host: 'whiteboard.example.com',
      },
    });

    createYWebsocketProvider(new Y.Doc(), 'connect-room');
    const instance = websocketCtor.mock.instances.at(-1) as unknown as {
      connect: ReturnType<typeof vi.fn>;
    };

    expect(instance?.connect).toHaveBeenCalled();

    destroyProvider('connect-room');
  });
});
