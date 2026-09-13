import { describe, expect, it } from 'vitest';

import {
  buildLiveKitRoomServiceToken,
  buildLiveKitToken,
  LIVEKIT_ROOM_SERVICE_TOKEN_TTL_SECONDS,
  LIVEKIT_TOKEN_TTL_SECONDS,
  parseLiveKitConfig,
  verifyLiveKitToken,
} from './livekitToken';

const API_KEY = 'api_key_123';
const SECRET = 'super_secret_abc';

describe('buildLiveKitToken', () => {
  it('produces a three-part HS256 JWT', async () => {
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-alpha',
      identity: 'user-1',
    });
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('is signed with the API secret and verifies', async () => {
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-alpha',
      identity: 'user-1',
    });
    const result = await verifyLiveKitToken(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload.iss).toBe(API_KEY);
    expect(result.payload.sub).toBe('user-1');
    const video = result.payload.video as Record<string, unknown>;
    expect(video.room).toBe('room-alpha');
  });

  it('fails verification with the wrong secret', async () => {
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-alpha',
      identity: 'user-1',
    });
    const result = await verifyLiveKitToken(token, 'wrong_secret');
    expect(result.valid).toBe(false);
  });

  it('sets a short-lived nbf/exp window', async () => {
    const before = Math.floor(Date.now() / 1000);
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'r',
      identity: 'i',
    });
    const result = await verifyLiveKitToken(token, SECRET);
    const after = Math.floor(Date.now() / 1000);
    const nbf = result.payload.nbf as number;
    const exp = result.payload.exp as number;
    expect(nbf).toBeGreaterThanOrEqual(before);
    expect(nbf).toBeLessThanOrEqual(after + 1);
    expect(exp).toBe(nbf + LIVEKIT_TOKEN_TTL_SECONDS);
  });

  it('respects a custom TTL', async () => {
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'r',
      identity: 'i',
      ttlSeconds: 120,
    });
    const result = await verifyLiveKitToken(token, SECRET);
    const nbf = result.payload.nbf as number;
    const exp = result.payload.exp as number;
    expect(exp - nbf).toBe(120);
  });

  it('embeds publish/subscribe grants and the room', async () => {
    const token = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-beta',
      identity: 'user-2',
      grant: { canPublish: false, canSubscribe: true },
    });
    const result = await verifyLiveKitToken(token, SECRET);
    const video = result.payload.video as Record<string, unknown>;
    expect(video.room).toBe('room-beta');
    expect(video.canPublish).toBe(false);
    expect(video.canSubscribe).toBe(true);
    expect(video.roomJoin).toBe(true);
  });

  it('carries a source allowlist only when one is given', async () => {
    // Absent means every source, which is LiveKit's own default; an allowlist
    // is how screen share is kept from everyone but the owner (Phase 10).
    const unrestricted = await buildLiveKitToken({
      apiKey: API_KEY, apiSecret: SECRET, room: 'room-sources', identity: 'owner',
    });
    const unrestrictedVideo = (await verifyLiveKitToken(unrestricted, SECRET)).payload.video as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(unrestrictedVideo, 'canPublishSources')).toBe(false);

    const limited = await buildLiveKitToken({
      apiKey: API_KEY, apiSecret: SECRET, room: 'room-sources', identity: 'student',
      grant: { canPublishSources: ['camera', 'microphone'] },
    });
    const limitedVideo = (await verifyLiveKitToken(limited, SECRET)).payload.video as Record<string, unknown>;
    expect(limitedVideo.canPublishSources).toEqual(['camera', 'microphone']);
  });

  it('pins the token TTL to one hour', () => {
    expect(LIVEKIT_TOKEN_TTL_SECONDS).toBe(3_600);
  });

  it('grants publish, subscribe, data, and join by default and honors explicit denials', async () => {
    const defaults = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-defaults',
      identity: 'user-defaults',
    });
    const defaultVideo = (await verifyLiveKitToken(defaults, SECRET)).payload.video as Record<string, unknown>;
    expect(defaultVideo).toMatchObject({
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomJoin: true,
      room: 'room-defaults',
    });

    const denied = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-denied',
      identity: 'user-denied',
      grant: { canPublish: false, canSubscribe: false, canPublishData: false, roomJoin: false },
    });
    const deniedVideo = (await verifyLiveKitToken(denied, SECRET)).payload.video as Record<string, unknown>;
    expect(deniedVideo).toMatchObject({
      canPublish: false,
      canSubscribe: false,
      canPublishData: false,
      roomJoin: false,
    });
  });

  it('carries the display name only when one is given', async () => {
    const named = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-name',
      identity: 'user-name',
      name: 'Ada Lovelace',
    });
    expect((await verifyLiveKitToken(named, SECRET)).payload.name).toBe('Ada Lovelace');

    const unnamed = await buildLiveKitToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-name',
      identity: 'user-name',
    });
    expect((await verifyLiveKitToken(unnamed, SECRET)).payload).not.toHaveProperty('name');
  });

  it('round-trips payloads whose base64 contains + or /', async () => {
    const candidates: string[] = [];
    for (let n = 0; n < 200 && candidates.length < 6; n += 1) {
      const apiKey = 'k'.repeat(n) + '\u20ac'.repeat(n % 5);
      const token = await buildLiveKitToken({
        apiKey,
        apiSecret: SECRET,
        room: `r+/${n}`,
        identity: `i?${n}`,
        name: 'A'.repeat(n),
      });
      const payloadJson = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
      if (Buffer.from(payloadJson, 'utf8').toString('base64').includes('+')) {
        candidates.push(token);
      }
    }
    expect(candidates.length).toBeGreaterThan(0);
    for (const token of candidates) {
      const result = await verifyLiveKitToken(token, SECRET);
      expect(result.valid).toBe(true);
      expect((result.payload.video as Record<string, unknown>).room).toMatch(/^r\+\//);
      expect(result.payload.iss).toMatch(/^k+\u20ac*$/);
    }
  });
});

describe('buildLiveKitRoomServiceToken', () => {
  it('pins the room service TTL and signs an admin token', async () => {
    expect(LIVEKIT_ROOM_SERVICE_TOKEN_TTL_SECONDS).toBe(60);

    const before = Math.floor(Date.now() / 1000);
    const token = await buildLiveKitRoomServiceToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-service',
    });
    const after = Math.floor(Date.now() / 1000);
    const result = await verifyLiveKitToken(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.payload.iss).toBe(API_KEY);
    expect(result.payload.sub).toBe(API_KEY);
    const nbf = result.payload.nbf as number;
    const exp = result.payload.exp as number;
    expect(nbf).toBeGreaterThanOrEqual(before);
    expect(nbf).toBeLessThanOrEqual(after + 1);
    expect(exp).toBe(nbf + LIVEKIT_ROOM_SERVICE_TOKEN_TTL_SECONDS);
    expect(result.payload.video).toEqual({ roomAdmin: true, room: 'room-service' });
  });

  it('respects a custom room service TTL', async () => {
    const token = await buildLiveKitRoomServiceToken({
      apiKey: API_KEY,
      apiSecret: SECRET,
      room: 'room-service',
      ttlSeconds: 5,
    });
    const result = await verifyLiveKitToken(token, SECRET);
    const nbf = result.payload.nbf as number;
    const exp = result.payload.exp as number;
    expect(exp - nbf).toBe(5);
  });
});

describe('parseLiveKitConfig', () => {
  it('returns null when any value is missing', () => {
    expect(parseLiveKitConfig({})).toBeNull();
    expect(parseLiveKitConfig({ LIVEKIT_URL: 'wss://x' })).toBeNull();
    expect(parseLiveKitConfig({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'key' })).toBeNull();
    expect(parseLiveKitConfig({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_SECRET: 'secret' })).toBeNull();
    expect(parseLiveKitConfig({ LIVEKIT_API_KEY: 'key', LIVEKIT_API_SECRET: 'secret' })).toBeNull();
  });

  /*
   * Whitespace is the failure this guards against, and it is invisible.
   *
   * A secret stored from a file or a copied line keeps its trailing newline,
   * and what comes out is a perfectly well-formed JWT signed with the wrong
   * key. LiveKit answers 401 to everything carrying it -- region settings,
   * validate, the signal socket -- and neither the token nor the logs point
   * at a stray character on the end of a secret.
   */
  it('trims surrounding whitespace off every value', () => {
    const config = parseLiveKitConfig({
      LIVEKIT_URL: '  wss://example.livekit.cloud\n',
      LIVEKIT_API_KEY: 'key\n',
      LIVEKIT_API_SECRET: '\tsecret  ',
    });
    expect(config).toEqual({
      url: 'wss://example.livekit.cloud',
      apiKey: 'key',
      apiSecret: 'secret',
    });
  });

  it('treats a value that is only whitespace as missing', () => {
    expect(parseLiveKitConfig({
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      LIVEKIT_API_KEY: '   ',
      LIVEKIT_API_SECRET: 'secret',
    })).toBeNull();
  });

  it('returns a config when all values are present', () => {
    const config = parseLiveKitConfig({
      LIVEKIT_URL: 'wss://example.livekit.cloud',
      LIVEKIT_API_KEY: 'key',
      LIVEKIT_API_SECRET: 'secret',
    });
    expect(config).toEqual({
      url: 'wss://example.livekit.cloud',
      apiKey: 'key',
      apiSecret: 'secret',
    });
  });
});
