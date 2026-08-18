import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyLiveKitToken } from './livekitToken';
import { liveKitHttpHost, removeLiveKitParticipant } from './livekitRoomService';

const LIVEKIT_ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'key_abc',
  LIVEKIT_API_SECRET: 'secret_xyz_long_enough',
};

describe('liveKitHttpHost', () => {
  it('converts wss LiveKit URLs to https and ws URLs to http', () => {
    expect(liveKitHttpHost('wss://example.livekit.cloud')).toBe(
      'https://example.livekit.cloud',
    );
    expect(liveKitHttpHost('ws://127.0.0.1:7880')).toBe('http://127.0.0.1:7880');
    expect(liveKitHttpHost('https://example.livekit.cloud')).toBe(
      'https://example.livekit.cloud',
    );
  });
});

describe('removeLiveKitParticipant', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('returns skipped when LiveKit is unconfigured', async () => {
    const result = await removeLiveKitParticipant({
      env: {},
      roomId: 'room-1',
      identity: 'acct-1',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs RemoveParticipant with wss converted to https', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      identity: 'acct-user',
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://example.livekit.cloud/twirp/livekit.RoomService/RemoveParticipant',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: expect.stringMatching(/^Bearer .+/),
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      room: 'room-alpha',
      identity: 'acct-user',
    });
  });

  it('authorizes with a short-lived roomAdmin JWT for the room', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      identity: 'acct-user',
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const auth = (init.headers as Record<string, string>).Authorization;
    const token = auth.replace(/^Bearer /, '');
    const verified = await verifyLiveKitToken(token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.iss).toBe(LIVEKIT_ENV.LIVEKIT_API_KEY);
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.roomAdmin).toBe(true);
    expect(video.room).toBe('room-alpha');
    const exp = verified.payload.exp as number;
    const nbf = verified.payload.nbf as number;
    expect(exp - nbf).toBeLessThanOrEqual(60);
  });

  it('returns ok on HTTP 200', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    const result = await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      identity: 'acct-1',
    });

    expect(result).toEqual({ ok: true });
  });

  it('returns ok false with status on HTTP 404', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    const result = await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      identity: 'acct-missing',
    });

    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('returns ok false with status on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      identity: 'acct-1',
    });

    expect(result).toEqual({ ok: false, status: 0 });
  });
});
