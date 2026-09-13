import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logAuthEvent,
  logSocketClose,
  serializeAuthEvent,
  type AuthEventInput,
} from './authEvents';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logAuthEvent', () => {
  it('writes structured JSON with type and outcome', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'auth_failure',
        roomId: 'room-abc123',
        outcome: 'denied',
        reason: 'missing session',
      },
      (line) => lines.push(line),
    );

    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!);
    expect(logged).toMatchObject({
      event: 'auth_event',
      type: 'auth_failure',
      roomId: 'room-abc123',
      outcome: 'denied',
      reason: 'missing session',
    });
  });

  it('never logs the session cookie or Access JWT on auth_failure lines', () => {
    const sessionCookie = '__Host-teacher-session=abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'auth_failure',
        outcome: 'denied',
        reason: [
          'Cookie: ' + sessionCookie,
          'Cf-Access-Jwt-Assertion: ' + JWT,
        ].join('; '),
      },
      (line) => lines.push(line),
    );

    const serialized = lines[0]!;
    expect(serialized).not.toContain(sessionCookie);
    expect(serialized).not.toContain('__Host-teacher-session=');
    expect(serialized).not.toContain(JWT);
    expect(JSON.parse(serialized)).toMatchObject({
      event: 'auth_event',
      type: 'auth_failure',
      outcome: 'denied',
    });
  });

  it('never logs Authorization values, bearer tokens, cookies, or emails', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'grant_change',
        accountId: 'acct-1',
        roomId: 'room-1',
        outcome: 'granted',
        reason: [
          'Authorization: Bearer ' + JWT,
          'Cookie: CF_Authorization=' + JWT,
          'contact teacher@example.com',
        ].join('; '),
      },
      (line) => lines.push(line),
    );

    const serialized = lines[0]!;
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain('teacher@example.com');
    expect(serialized).not.toMatch(/Bearer\s+eyJ/i);

    const logged = JSON.parse(serialized);
    expect(logged.type).toBe('grant_change');
    expect(logged.outcome).toBe('granted');
    expect(JSON.stringify(logged)).not.toContain('teacher@example.com');
    expect(JSON.stringify(logged)).not.toMatch(/Bearer\s+eyJ/i);
  });

  it('redacts email-shaped accountId values', () => {
    const lines: string[] = [];
    logAuthEvent(
      {
        type: 'revocation',
        accountId: 'teacher@example.com',
        outcome: 'revoked',
      },
      (line) => lines.push(line),
    );

    const serialized = lines[0]!;
    expect(serialized).not.toContain('teacher@example.com');
    const logged = JSON.parse(serialized);
    expect(logged.accountId).not.toBe('teacher@example.com');
    expect(logged.type).toBe('revocation');
    expect(logged.outcome).toBe('revoked');
  });

  it('covers all auth event types', () => {
    const types: AuthEventInput['type'][] = [
      'auth_failure',
      'grant_change',
      'revocation',
      'rate_limit',
      'socket_close',
    ];
    const lines: string[] = [];

    for (const type of types) {
      logAuthEvent({ type, outcome: 'ok' }, (line) => lines.push(line));
    }

    expect(lines).toHaveLength(types.length);
    lines.forEach((line, index) => {
      const logged = JSON.parse(line);
      expect(logged.type).toBe(types[index]);
      expect(logged.outcome).toBe('ok');
    });
  });

  it('defaults to console.info for the structured log line', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    logAuthEvent({ type: 'rate_limit', outcome: 'blocked' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      event: 'auth_event',
      type: 'rate_limit',
      outcome: 'blocked',
    });
  });
});

describe('serializeAuthEvent redaction hardening', () => {
  it('hashes a whitespace-padded whole-field email with the deterministic marker', () => {
    expect(
      serializeAuthEvent({
        type: 'revocation',
        accountId: '  teacher@example.com  ',
        outcome: 'revoked',
      }),
    ).toStrictEqual({
      event: 'auth_event',
      type: 'revocation',
      accountId: '[REDACTED:d70f179f]',
      outcome: 'revoked',
    });
  });

  it('hashes a whole-field JWT with the deterministic marker', () => {
    expect(
      serializeAuthEvent({ type: 'revocation', accountId: JWT, outcome: 'revoked' }),
    ).toStrictEqual({
      event: 'auth_event',
      type: 'revocation',
      accountId: '[REDACTED:7149f33f]',
      outcome: 'revoked',
    });
  });

  it('omits absent optional fields instead of carrying undefined keys', () => {
    const entry = serializeAuthEvent({ type: 'rate_limit', outcome: 'blocked' });

    expect(entry).toStrictEqual({
      event: 'auth_event',
      type: 'rate_limit',
      outcome: 'blocked',
    });
    expect(Object.hasOwn(entry, 'accountId')).toBe(false);
    expect(Object.hasOwn(entry, 'roomId')).toBe(false);
    expect(Object.hasOwn(entry, 'reason')).toBe(false);
  });

  it('hashes an exactly whole bearer credential and leaves padded variants inline-redacted', () => {
    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'Bearer sekret123', outcome: 'denied' }),
    ).toStrictEqual({
      event: 'auth_event',
      type: 'auth_failure',
      accountId: '[REDACTED:c1c6f1ab]',
      outcome: 'denied',
    });

    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'Bearer  sekret123', outcome: 'denied' }),
    ).toStrictEqual({
      event: 'auth_event',
      type: 'auth_failure',
      accountId: '[REDACTED:92ed0d69]',
      outcome: 'denied',
    });
  });

  it('does not hash a bearer credential with a prefix or suffix', () => {
    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'x Bearer sekret123', outcome: 'denied' })
        .accountId,
    ).toBe('x Bearer [REDACTED_TOKEN]');

    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'Bearer sekret123 extra',
        outcome: 'denied',
      }).accountId,
    ).toBe('Bearer [REDACTED_TOKEN] extra');
  });

  it('hashes exactly whole cookie values', () => {
    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'name=value', outcome: 'denied' })
        .accountId,
    ).toBe('[REDACTED:adf6559f]');

    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'Cookie: name=value', outcome: 'denied' })
        .accountId,
    ).toBe('[REDACTED:8f3f75c9]');

    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: 'Cookie:name=value', outcome: 'denied' })
        .accountId,
    ).toBe('[REDACTED:8f256455]');

    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'Cookie:\nname=value',
        outcome: 'denied',
      }).accountId,
    ).toBe('[REDACTED:c3981933]');

    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: '__Host-teacher-session=abcdef',
        outcome: 'denied',
      }).accountId,
    ).toBe('[REDACTED:aeb42e9a]');
  });

  it('inline-redacts cookie assignments that are not whole fields', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'x Cookie: name=value',
        outcome: 'denied',
      }).accountId,
    ).toBe('x [REDACTED_COOKIE]');

    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'name=value\nother',
        outcome: 'denied',
      }).accountId,
    ).toBe('[REDACTED_COOKIE]\nother');

    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'x Cookie:\nname=value',
        outcome: 'denied',
      }).accountId,
    ).toBe('x [REDACTED_COOKIE]');
  });

  it('does not treat a non-cookie "ookie:" prefix as a credential', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        accountId: 'Xookie:name=value\nother',
        outcome: 'denied',
      }).accountId,
    ).toBe('Xookie:name=value\nother');
  });

  it('does not hash a JWT with a prefix or suffix', () => {
    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: `-${JWT}`, outcome: 'denied' })
        .accountId,
    ).toBe('-[REDACTED_TOKEN]');

    expect(
      serializeAuthEvent({ type: 'auth_failure', accountId: `${JWT}!`, outcome: 'denied' })
        .accountId,
    ).toBe('[REDACTED_TOKEN]!');
  });

  it('marks every reachable inline redaction kind explicitly', () => {
    const entry = serializeAuthEvent({
      type: 'grant_change',
      outcome: 'granted',
      reason: `Authorization: Bearer sekret123 Cookie:name=value assertion ${JWT}`,
    });

    expect(entry.reason).toBe(
      'Authorization: Bearer [REDACTED_TOKEN] [REDACTED_COOKIE] assertion [REDACTED_TOKEN]',
    );
  });

  it('redacts a single-space bearer token with an exact replacement', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        outcome: 'denied',
        reason: 'Authorization: Bearer sekret123',
      }).reason,
    ).toBe('Authorization: Bearer [REDACTED_TOKEN]');
  });

  it('redacts a double-space bearer token with an exact replacement', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        outcome: 'denied',
        reason: 'Authorization: Bearer  sekret123',
      }).reason,
    ).toBe('Authorization: Bearer [REDACTED_TOKEN]');
  });

  it('redacts a bare JWT with an exact replacement', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        outcome: 'denied',
        reason: `assertion ${JWT}`,
      }).reason,
    ).toBe('assertion [REDACTED_TOKEN]');
  });

  it('redacts an inline cookie assignment with an exact replacement', () => {
    expect(
      serializeAuthEvent({
        type: 'auth_failure',
        outcome: 'denied',
        reason: 'x Cookie:name=value',
      }).reason,
    ).toBe('x [REDACTED_COOKIE]');
  });
});

describe('logSocketClose', () => {
  it('emits socket_close with reason rate for 1008', () => {
    const lines: string[] = [];
    logSocketClose(
      { code: 1008, accountId: 'acct-rate', roomId: 'room-rate' },
      (line) => lines.push(line),
    );

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      event: 'auth_event',
      type: 'socket_close',
      outcome: 'closed',
      reason: 'rate',
      accountId: 'acct-rate',
      roomId: 'room-rate',
    });
  });

  it('emits socket_close with reason oversized for 1009', () => {
    const lines: string[] = [];
    logSocketClose({ code: 1009, roomId: 'room-size' }, (line) => lines.push(line));

    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'socket_close',
      outcome: 'closed',
      reason: 'oversized',
      roomId: 'room-size',
    });
  });

  it('emits socket_close with reason revoke for 4401', () => {
    const lines: string[] = [];
    logSocketClose(
      { code: 4401, accountId: 'acct-revoked', roomId: 'room-revoked' },
      (line) => lines.push(line),
    );

    expect(JSON.parse(lines[0]!)).toMatchObject({
      type: 'socket_close',
      outcome: 'closed',
      reason: 'revoke',
      accountId: 'acct-revoked',
      roomId: 'room-revoked',
    });
  });
});
