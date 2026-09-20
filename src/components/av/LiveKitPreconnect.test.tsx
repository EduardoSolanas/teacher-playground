import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import LiveKitPreconnect, { liveKitPreconnectHref } from './LiveKitPreconnect';
import WhiteboardRoomLayout from '@/app/whiteboard/[roomId]/layout';

/*
 * PERF-S5: the LiveKit edge host is the one cross-origin thing a room talks
 * to, and the TLS+TCP handshake for it can start before a single call button
 * is pressed. The signaling socket is same-origin (/signaling), so it needs
 * no hint at all -- the page itself arrived over that origin's warm
 * connection.
 *
 * The client only learns the LiveKit origin from the token response, long
 * after render, so the hint is opt-in at build time: the deployment sets
 * NEXT_PUBLIC_LIVEKIT_HINT to the same origin LIVEKIT_URL points at. No env,
 * no link -- a hint guessed from nothing would be a lie the browser pays for.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('liveKitPreconnectHref', () => {
  it('upgrades a wss:// LiveKit URL to the https origin to preconnect', () => {
    expect(liveKitPreconnectHref('wss://myproject.livekit.cloud')).toBe(
      'https://myproject.livekit.cloud',
    );
  });

  it('keeps an https hint as its own origin', () => {
    expect(liveKitPreconnectHref('https://myproject.livekit.cloud')).toBe(
      'https://myproject.livekit.cloud',
    );
  });

  it('trims whitespace the same way the server trims LIVEKIT_URL', () => {
    expect(liveKitPreconnectHref('  wss://myproject.livekit.cloud\n')).toBe(
      'https://myproject.livekit.cloud',
    );
  });

  it('accepts no hint it cannot honestly preconnect', () => {
    expect(liveKitPreconnectHref(undefined)).toBeNull();
    expect(liveKitPreconnectHref('')).toBeNull();
    expect(liveKitPreconnectHref('   ')).toBeNull();
    // ws:// and http:// would preconnect a plaintext origin nobody talks to.
    expect(liveKitPreconnectHref('ws://myproject.livekit.cloud')).toBeNull();
    expect(liveKitPreconnectHref('http://myproject.livekit.cloud')).toBeNull();
    // Not a URL at all.
    expect(liveKitPreconnectHref('myproject.livekit.cloud')).toBeNull();
  });
});

describe('LiveKitPreconnect', () => {
  it('renders no link when no hint is configured', () => {
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_HINT', '');

    render(<LiveKitPreconnect />);

    expect(document.querySelector('link[data-testid="livekit-preconnect"]')).toBeNull();
  });

  it('preconnects the configured LiveKit origin', () => {
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_HINT', 'wss://myproject.livekit.cloud');

    render(<LiveKitPreconnect />);

    const link = document.querySelector('link[data-testid="livekit-preconnect"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('rel')).toBe('preconnect');
    expect(link?.getAttribute('href')).toBe('https://myproject.livekit.cloud');
    // The media socket is not credentialed, so the shared connection must be
    // the anonymous one for the browser to reuse it.
    expect(link?.getAttribute('crossorigin')).toBe('anonymous');
  });
});

describe('WhiteboardRoomLayout', () => {
  it('renders the room inside the layout without a hint configured', () => {
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_HINT', '');

    const { container } = render(
      <WhiteboardRoomLayout>
        <div>room-body</div>
      </WhiteboardRoomLayout>,
    );

    expect(container.textContent).toContain('room-body');
    expect(document.querySelector('link[data-testid="livekit-preconnect"]')).toBeNull();
  });

  it('carries the LiveKit preconnect hint on the room route', () => {
    vi.stubEnv('NEXT_PUBLIC_LIVEKIT_HINT', 'wss://myproject.livekit.cloud');

    const { container } = render(
      <WhiteboardRoomLayout>
        <div>room-body</div>
      </WhiteboardRoomLayout>,
    );

    expect(container.textContent).toContain('room-body');
    expect(
      document.querySelector('link[data-testid="livekit-preconnect"]')?.getAttribute('href'),
    ).toBe('https://myproject.livekit.cloud');
  });
});
