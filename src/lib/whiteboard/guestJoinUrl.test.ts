import { afterEach, describe, expect, it, vi } from 'vitest';

import { guestHostJoinUrl } from './guestJoinUrl';

const ROOM_ID = 'room-alpha';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('guestHostJoinUrl', () => {
  it('uses an explicitly configured guest hostname', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'join.example.com');

    const url = guestHostJoinUrl(ROOM_ID, 'https://app.example.com');

    expect(url).toBe('https://join.example.com/whiteboard/room-alpha');
    expect(new URL(url).origin).toBe('https://join.example.com');
  });

  it('preserves the scheme and port of an explicitly configured guest origin', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', 'http://join.localhost:8787');

    const url = guestHostJoinUrl(ROOM_ID, 'https://app.example.com');

    expect(new URL(url).origin).toBe('http://join.localhost:8787');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
  });

  it('rewrites the first label only when the origin has at least three labels', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'https://app.example.com');

    expect(new URL(url).origin).toBe('https://join.example.com');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
  });

  it('preserves scheme and port when it rewrites a three-label origin', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'http://app.example.com:8443');

    expect(new URL(url).origin).toBe('http://join.example.com:8443');
  });

  it('never turns a two-label origin into a different registrable domain', () => {
    /*
     * The old fallback replaced the first label whatever the host: on
     * `example.com` it produced `join.com`, a domain nobody owns, and the
     * teacher's copy button confidently handed out an invite to it. A
     * two-label host has no `app.` subdomain to swap, so it is left alone;
     * deployments that need a real guest hostname configure one.
     */
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'https://example.com');

    expect(new URL(url).origin).toBe('https://example.com');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
    expect(url).not.toContain('join.com');
  });

  it('leaves an IPv4-literal origin alone rather than rewriting a label into join.*', () => {
    /*
     * An IPv4 address has four dot-separated labels, so the >=3-label guard
     * treated 127.0.0.1 as if it were `app.example.com` and produced
     * `join.0.0.1` -- a host that resolves nowhere. A literal address is not
     * a registrable domain with a subdomain to swap, so it is left alone.
     */
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'http://127.0.0.1:3000');

    expect(new URL(url).origin).toBe('http://127.0.0.1:3000');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
    expect(url).not.toContain('join.0.0.1');
  });

  it('keeps the single-label local development fallback', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'http://localhost:3000');

    expect(new URL(url).origin).toBe('http://join.localhost:3000');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
  });

  it('falls back to join.localhost when the current origin is unparseable', () => {
    vi.stubEnv('NEXT_PUBLIC_GUEST_HOSTNAME', '');

    const url = guestHostJoinUrl(ROOM_ID, 'not a url');

    expect(new URL(url).origin).toBe('https://join.localhost');
    expect(new URL(url).pathname).toBe('/whiteboard/room-alpha');
  });
});
