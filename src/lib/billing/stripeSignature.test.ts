import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from './stripeSignature';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

describe('verifyStripeSignature', () => {
  it('returns valid with the payload hash for a signature produced by the only secret', async () => {
    const body = '{"type":"invoice.paid","id":"evt_1"}';
    const v1 = await hmacHex('whsec_alpha', `${NOW_SEC}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${NOW_SEC},v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: true, payloadHash: await sha256Hex(body) });
  });

  it('rejects a body that was tampered after signing', async () => {
    const v1 = await hmacHex('whsec_alpha', `${NOW_SEC}.{"a":1}`);
    const result = await verifyStripeSignature(
      '{"a":2}',
      `t=${NOW_SEC},v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a timestamp older than the tolerance', async () => {
    const body = '{"type":"invoice.paid"}';
    const oldSec = NOW_SEC - 400;
    const v1 = await hmacHex('whsec_alpha', `${oldSec}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${oldSec},v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects a timestamp newer than the tolerance', async () => {
    const body = '{"type":"invoice.paid"}';
    const futureSec = NOW_SEC + 400;
    const v1 = await hmacHex('whsec_alpha', `${futureSec}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${futureSec},v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('accepts a signature produced by the second of two rotated secrets', async () => {
    const body = '{"type":"invoice.paid"}';
    const v1 = await hmacHex('whsec_beta', `${NOW_SEC}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${NOW_SEC},v1=${v1}`,
      ['whsec_alpha', 'whsec_beta'],
      NOW_MS,
    );
    expect(result.valid).toBe(true);
  });

  it('ignores extra non-v1 entries in the header', async () => {
    const body = '{"type":"invoice.paid"}';
    const v1 = await hmacHex('whsec_alpha', `${NOW_SEC}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${NOW_SEC},foo=bar,hello=world,v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: true, payloadHash: await sha256Hex(body) });
  });

  it('returns missing_header when the header is absent', async () => {
    const result = await verifyStripeSignature('{}', null, ['whsec_alpha'], NOW_MS);
    expect(result).toEqual({ valid: false, reason: 'missing_header' });
  });

  it('returns no_v1 when the header carries no v1 part', async () => {
    const result = await verifyStripeSignature('{}', `t=${NOW_SEC}`, ['whsec_alpha'], NOW_MS);
    expect(result).toEqual({ valid: false, reason: 'no_v1' });
  });

  it('returns mismatch when no supplied secret matches', async () => {
    const v1 = await hmacHex('whsec_alpha', `${NOW_SEC}.{"a":1}`);
    const result = await verifyStripeSignature(
      '{"a":1}',
      `t=${NOW_SEC},v1=${v1}`,
      ['whsec_wrong'],
      NOW_MS,
    );
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('returns no_matching_secret when the secrets list is empty', async () => {
    const result = await verifyStripeSignature(
      '{}',
      `t=${NOW_SEC},v1=deadbeef`,
      [],
      NOW_MS,
    );
    expect(result).toEqual({ valid: false, reason: 'no_matching_secret' });
  });

  it('exposes the payloadHash as the lowercase hex SHA-256 of the raw body', async () => {
    const body = '{"type":"checkout.session.completed","id":"evt_2"}';
    const v1 = await hmacHex('whsec_alpha', `${NOW_SEC}.${body}`);
    const result = await verifyStripeSignature(
      body,
      `t=${NOW_SEC},v1=${v1}`,
      ['whsec_alpha'],
      NOW_MS,
    );
    expect(result.valid ? result.payloadHash : null).toBe(await sha256Hex(body));
  });
});