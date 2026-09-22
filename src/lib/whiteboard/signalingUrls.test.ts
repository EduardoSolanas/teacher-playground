import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSignalingUrls,
  isWhiteboardDebugEnabled,
  sanitizeSignalingUrl,
} from './signalingUrls';

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

  it('falls back to the local signaling server when there is no window', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NODE_ENV', 'development');

    expect(getSignalingUrls()).toEqual(['ws://localhost:3001/signaling']);
  });

  it('returns no signaling URLs on a production server', () => {
    vi.stubGlobal('window', undefined);
    vi.stubEnv('NODE_ENV', 'production');

    expect(getSignalingUrls()).toEqual([]);
  });
});

describe('production signaling URL policy', () => {
  it('rejects ws:, credentials, fragments, unexpected paths, and extra query', () => {
    const policy = { production: true, pageHost: 'whiteboard.example.com' };

    expect(sanitizeSignalingUrl('ws://whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://user:pass@whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://user@whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://:pass@whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/signaling#frag', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/other', policy)).toBeNull();
    expect(sanitizeSignalingUrl('wss://whiteboard.example.com/signaling?x=1', policy)).toBeNull();
    expect(sanitizeSignalingUrl('https://whiteboard.example.com/signaling', policy)).toBeNull();
  });

  it('rejects non-websocket protocols in development too', () => {
    const policy = { production: false };

    expect(sanitizeSignalingUrl('https://whiteboard.example.com/signaling', policy)).toBeNull();
    expect(sanitizeSignalingUrl('http://whiteboard.example.com/signaling', policy)).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS', '');

    expect(
      sanitizeSignalingUrl('  wss://whiteboard.example.com/signaling  ', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://whiteboard.example.com/signaling');
  });

  it('trims Unicode whitespace the URL parser does not strip', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS', '');

    expect(
      sanitizeSignalingUrl('\u00A0wss://whiteboard.example.com/signaling', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://whiteboard.example.com/signaling');
  });

  it('returns null when the input cannot be parsed as a URL', () => {
    expect(() => sanitizeSignalingUrl('not a url', { production: false })).not.toThrow();
    expect(sanitizeSignalingUrl('not a url', { production: false })).toBeNull();
  });

  it('accepts an allowlisted host that carries an explicit port', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS', 'signals.example.com:8443');

    expect(
      sanitizeSignalingUrl('wss://signals.example.com:8443/signaling', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://signals.example.com:8443/signaling');
  });

  it('trims whitespace around allowlisted hosts', () => {
    vi.stubEnv('NEXT_PUBLIC_YWEBRTC_SIGNALING_ALLOWED_HOSTS', '  signals.example.com  , ');

    expect(
      sanitizeSignalingUrl('wss://signals.example.com/signaling', {
        production: true,
        pageHost: 'whiteboard.example.com',
      }),
    ).toBe('wss://signals.example.com/signaling');
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

  it('is on when NEXT_PUBLIC_E2E=1 even in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_WHITEBOARD_DEBUG', '');
    vi.stubEnv('NEXT_PUBLIC_E2E', '1');

    expect(isWhiteboardDebugEnabled()).toBe(true);
  });
});
