import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

import { applySchema } from '../whiteboard/roomSchema';
import {
  approveAccount,
  insertOwner,
  requestAccess,
} from '../whiteboard/membership';
import type { RoomDatabase } from '../whiteboard/db';
import { issueAvTokenResponse } from './handleAvToken';
import { verifyLiveKitToken } from './livekitToken';
import { deriveLiveKitIdentity } from './participantIdentity';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { liveKitHttpHost, removeLiveKitParticipant, muteLiveKitParticipant, setLiveKitScreenShare } from './livekitRoomService';

const LIVEKIT_ENV = {
  LIVEKIT_URL: 'wss://example.livekit.cloud',
  LIVEKIT_API_KEY: 'key_abc',
  LIVEKIT_API_SECRET: 'secret_xyz',
};

/** The identity the server derives for an account in a room (audit M4). */
function identityFor(roomId: string, accountId: string): Promise<string> {
  return deriveLiveKitIdentity(LIVEKIT_ENV.LIVEKIT_API_SECRET, roomId, accountId);
}

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
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs RemoveParticipant with wss converted to https', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      accountId: 'acct-user',
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
      identity: await identityFor('room-alpha', 'acct-user'),
    });
  });

  it('authorizes with a short-lived roomAdmin JWT for the room', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      accountId: 'acct-user',
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
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: true });
  });

  it('returns ok false with status on HTTP 404', async () => {
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

    const result = await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-missing',
    });

    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('returns ok false with status on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    const result = await removeLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: false, status: 0 });
  });
});

describe('muteLiveKitParticipant', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('returns skipped when LiveKit is unconfigured', async () => {
    const result = await muteLiveKitParticipant({
      env: {},
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls GetParticipant to find audio track', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'track-1', type: 'AUDIO', source: 'MICROPHONE' },
            { sid: 'track-2', type: 'VIDEO', source: 'CAMERA' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      accountId: 'acct-user',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [getUrl, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(getUrl).toBe(
      'https://example.livekit.cloud/twirp/livekit.RoomService/GetParticipant',
    );
    expect(getInit.method).toBe('POST');
    expect(JSON.parse(getInit.body as string)).toEqual({
      room: 'room-alpha',
      identity: await identityFor('room-alpha', 'acct-user'),
    });
  });

  it('calls MutePublishedTrack with the audio track sid', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'audio-sid-123', type: 'AUDIO' },
            { sid: 'video-sid-456', type: 'VIDEO' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-beta',
      accountId: 'acct-user',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [muteUrl, muteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(muteUrl).toBe(
      'https://example.livekit.cloud/twirp/livekit.RoomService/MutePublishedTrack',
    );
    expect(muteInit.method).toBe('POST');
    expect(JSON.parse(muteInit.body as string)).toEqual({
      room: 'room-beta',
      identity: await identityFor('room-beta', 'acct-user'),
      track_sid: 'audio-sid-123',
      muted: true,
    });
  });

  it('can mute the participant camera track when asked for video', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'audio-sid-123', type: 'AUDIO', source: 'MICROPHONE' },
            { sid: 'video-sid-456', type: 'VIDEO', source: 'CAMERA' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-video',
      accountId: 'acct-user',
      kind: 'video',
    });

    const [, muteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(muteInit.body as string)).toEqual({
      room: 'room-video',
      identity: await identityFor('room-video', 'acct-user'),
      track_sid: 'video-sid-456',
      muted: true,
    });
  });

  it('picks first audio track even when source is MICROPHONE', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'non-audio', type: 'VIDEO' },
            { sid: 'correct-audio', source: 'MICROPHONE' },
            { sid: 'should-not-use', type: 'AUDIO' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-gamma',
      accountId: 'acct-user',
    });

    const [muteUrl, muteInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(muteInit.body as string).track_sid).toBe('correct-audio');
  });

  it('returns skipped when participant has no audio track', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'video-only', type: 'VIDEO' },
          ],
        },
      }),
      { status: 200 },
    ));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns skipped when participant has no camera track for a video mute', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [{ sid: 'audio-only', type: 'AUDIO', source: 'MICROPHONE' }],
        },
      }),
      { status: 200 },
    ));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
      kind: 'video',
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns ok false when GetParticipant returns non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-missing',
    });

    expect(result).toEqual({ ok: false, status: 404 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns ok false when MutePublishedTrack returns non-200', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'track-1', type: 'AUDIO' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('error', { status: 500 }));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: false, status: 500 });
  });

  it('returns ok true when MutePublishedTrack returns 200', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'track-1', type: 'AUDIO' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: true });
  });

  it('returns ok false with status 0 on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const result = await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-1',
      accountId: 'acct-1',
    });

    expect(result).toEqual({ ok: false, status: 0 });
  });

  it('authorizes with a real roomAdmin JWT for the room', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        participant: {
          identity: 'acct-user',
          tracks: [
            { sid: 'track-1', type: 'AUDIO' },
          ],
        },
      }),
      { status: 200 },
    )).mockResolvedValueOnce(new Response('', { status: 200 }));

    await muteLiveKitParticipant({
      env: LIVEKIT_ENV,
      roomId: 'room-alpha',
      accountId: 'acct-user',
    });

    const [, getInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const auth = (getInit.headers as Record<string, string>).Authorization;
    const token = auth.replace(/^Bearer /, '');
    const verified = await verifyLiveKitToken(token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.iss).toBe(LIVEKIT_ENV.LIVEKIT_API_KEY);
    const video = verified.payload.video as Record<string, unknown>;
    expect(video.roomAdmin).toBe(true);
    expect(video.room).toBe('room-alpha');
  });
});

/*
 * A real HTTP server standing in for the LiveKit host: the request is sent over
 * a real socket by the real fetch, and the test reads what actually arrived.
 */
describe('setLiveKitScreenShare', () => {
  let server: Server;
  let port = 0;
  let status = 200;
  const received: { url: string; authorization: string; contentType: string; body: unknown }[] = [];

  beforeEach(async () => {
    received.length = 0;
    status = 200;
    server = createServer((request: IncomingMessage, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        received.push({
          url: request.url ?? '',
          authorization: request.headers.authorization ?? '',
          contentType: request.headers['content-type'] ?? '',
          body: raw ? JSON.parse(raw) : null,
        });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const envFor = () => ({ ...LIVEKIT_ENV, LIVEKIT_URL: `ws://127.0.0.1:${port}` });

  it('grants screen share on the live call with UpdateParticipant, keeping camera and microphone', async () => {
    const result = await setLiveKitScreenShare({ env: envFor(), roomId: 'room-share', accountId: 'acct-student', allowed: true });

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect(received[0].url).toBe('/twirp/livekit.RoomService/UpdateParticipant');
    // Twirp decides JSON versus protobuf from this header.
    expect(received[0].contentType).toBe('application/json');
    expect(received[0].body).toEqual({
      room: 'room-share',
      identity: await identityFor('room-share', 'acct-student'),
      permission: {
        can_subscribe: true,
        can_publish: true,
        can_publish_data: true,
        can_publish_sources: ['CAMERA', 'MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'],
      },
    });
    const token = received[0].authorization.replace(/^Bearer /, '');
    const verified = await verifyLiveKitToken(token, LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(verified.valid).toBe(true);
    expect(verified.payload.video).toMatchObject({ roomAdmin: true, room: 'room-share' });
  });

  it('targets the exact identity the join token was minted with for that account and room', async () => {
    // The mint path and the Room Service path are separate code paths that
    // must land on the same value, or UpdateParticipant widens nobody and the
    // owner's screen-share grant silently does nothing. Real objects end to
    // end: a real room database, the real token mint, a real HTTP server.
    const db = new Database(':memory:') as unknown as RoomDatabase;
    applySchema(db);
    insertOwner(db, 'room-share', 'acct-owner');
    requestAccess(db, { roomId: 'room-share', accountId: 'acct-student', userName: 'Student' });
    approveAccount(db, 'room-share', 'acct-student', { role: 'editor' });

    const mintResponse = await issueAvTokenResponse({
      db,
      env: envFor(),
      roomId: 'room-share',
      accountId: 'acct-student',
    });
    expect(mintResponse.status).toBe(200);
    const minted = (await mintResponse.json()) as { identity: string };
    expect(minted.identity).not.toBe('acct-student');

    const result = await setLiveKitScreenShare({
      env: envFor(),
      roomId: 'room-share',
      accountId: 'acct-student',
      allowed: true,
    });

    expect(result).toEqual({ ok: true });
    expect(received).toHaveLength(1);
    expect((received[0].body as { identity: string }).identity).toBe(minted.identity);
  });

  it('withdraws screen share by narrowing the sources back to camera and microphone', async () => {
    const result = await setLiveKitScreenShare({ env: envFor(), roomId: 'room-share', accountId: 'acct-student', allowed: false });

    expect(result).toEqual({ ok: true });
    expect((received[0].body as { permission: { can_publish_sources: string[] } }).permission.can_publish_sources)
      .toEqual(['CAMERA', 'MICROPHONE']);
  });

  it('reports the status when LiveKit refuses, and skips when LiveKit is not configured', async () => {
    status = 404;
    expect(await setLiveKitScreenShare({ env: envFor(), roomId: 'room-share', accountId: 'gone', allowed: true }))
      .toEqual({ ok: false, status: 404 });

    const unconfigured = await setLiveKitScreenShare({ env: {}, roomId: 'room-share', accountId: 'acct', allowed: true });
    expect(unconfigured).toEqual({ ok: true, skipped: true });
    expect(received).toHaveLength(1);
  });

  it('reports status 0 when the LiveKit host cannot be reached', async () => {
    const closedPort = port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer();
    const result = await setLiveKitScreenShare({
      env: { ...LIVEKIT_ENV, LIVEKIT_URL: `ws://127.0.0.1:${closedPort}` },
      roomId: 'room-share',
      accountId: 'acct',
      allowed: true,
    });
    expect(result).toEqual({ ok: false, status: 0 });
  });
});
