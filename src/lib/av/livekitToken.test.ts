import { describe, expect, it } from 'vitest';

import {
  buildLiveKitToken,
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
});

describe('parseLiveKitConfig', () => {
  it('returns null when any value is missing', () => {
    expect(parseLiveKitConfig({})).toBeNull();
    expect(parseLiveKitConfig({ LIVEKIT_URL: 'wss://x' })).toBeNull();
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
